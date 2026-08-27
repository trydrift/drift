import type {
  BreakingChange,
  ImpactSite,
  RuntimeCompatibilityReason,
  RuntimeCompatibilityState,
  RuntimeName,
  RuntimeRequirement,
} from '../types.js';
import {
  checkRuntimeCompatibility,
  checkUnsupportedRuntimeRange,
  discoverRuntimeDeclarations,
  parsePythonRuntimeRange,
  type RuntimeCompatibility,
  type RuntimeDeclaration,
  type UnresolvedRuntimeDeclaration,
} from './runtime.js';

/**
 * The runtime compatibility state machine.
 *
 * One flow, in one place, so no consumer downstream has to re-derive any part
 * of it from a count:
 *
 * ```
 * upstream prose  -> RuntimeRequirement (parsed, or explicitly unparsed)
 * repository      -> declaration discovery (resolved + unresolved)
 * both            -> RuntimeRequirementAnalysis  <- the answer
 *                 -> ImpactSites, only for concrete locations worth showing
 * ```
 *
 * The invariant every part of this module exists to hold: **an empty list of
 * impact sites means nothing about compatibility.** A repository that
 * declares nothing, a repository whose only declaration is a CI matrix
 * expression, and a repository whose declared version comfortably satisfies
 * the requirement all produce zero sites, and only the last of the three is
 * compatible. Anything that reads `sites.length === 0` as "fine" is reading a
 * fact that was never recorded.
 */

/** What Drift established, for one runtime requirement, in one workspace. */
export interface RuntimeRequirementAnalysis {
  /** The `BreakingChange.id` this answers. */
  changeId: string;
  /** Exact upstream requirement answered; runtime names alone are not unique facts. */
  requirement: string;
  runtime: RuntimeName;
  state: RuntimeCompatibilityState;
  reason: RuntimeCompatibilityReason;
  /** Declarations Drift read a version out of, with their per-declaration verdict. */
  declarations: RuntimeCompatibility[];
  /** Runtime-specific declaration positions whose value Drift could not resolve. */
  unresolved: UnresolvedRuntimeDeclaration[];
  /**
   * Concrete locations worth showing a developer. Never synthesized: a
   * `no-declaration` analysis has zero sites and is still `unknown`, because
   * `unknown` is a state, not a place in a file.
   */
  sites: ImpactSite[];
  /** The sentence the report says about this, matched to the state. */
  statement: string;
}

/**
 * Close runtime-analysis coverage before any downstream decision is made.
 * Every runtime finding leaves this function with exactly one answer. Missing
 * or duplicate answers are analysis failures, never implicit compatibility.
 */
export function completeRuntimeAnalyses(
  changes: readonly BreakingChange[],
  analyses: readonly RuntimeRequirementAnalysis[],
): RuntimeRequirementAnalysis[] {
  const runtimeChanges = changes.filter((change) => change.kind === 'runtime-requirement');
  const runtimeIds = new Set(runtimeChanges.map((change) => change.id));
  const byId = new Map<string, RuntimeRequirementAnalysis[]>();
  for (const analysis of analyses) {
    if (!runtimeIds.has(analysis.changeId)) continue;
    const bucket = byId.get(analysis.changeId);
    if (bucket) bucket.push(analysis);
    else byId.set(analysis.changeId, [analysis]);
  }

  return runtimeChanges.map((change) => {
    const matches = byId.get(change.id) ?? [];
    if (matches.length === 1 && matches[0]!.runtime === change.runtime?.runtime) return matches[0]!;
    const runtime = change.runtime?.runtime;
    if (!runtime) {
      throw new Error(`Runtime breaking change ${change.id} has no structured runtime identity`);
    }
    return {
      changeId: change.id,
      runtime,
      requirement: change.runtime?.requirement ?? '',
      state: 'unknown',
      reason: 'not-analyzed',
      declarations: [],
      unresolved: [],
      sites: [],
      statement: `Drift could not complete runtime compatibility analysis for this ${runtime} requirement.`,
    };
  });
}

/**
 * Answer one upstream runtime requirement against this repository.
 *
 * Returns `null` only when the change carries no structured runtime
 * requirement at all — i.e. there was no question to answer. Every other
 * outcome, including every kind of failure, is a state.
 */
export function analyzeRuntimeRequirement(
  change: BreakingChange,
  files: readonly { path: string; content: string }[],
  member?: string,
  allMembers?: readonly string[],
): RuntimeRequirementAnalysis | null {
  const requirement = change.runtime;
  if (!requirement?.runtime || !requirement.requirement) return null;
  const runtime = requirement.runtime;

  // Upstream named a runtime Drift understands and a range it does not — most
  // often a caret or bare tilde against Python, which PEP 440 simply has no
  // operator for. Evaluating it anyway is how a made-up `partial` gets
  // manufactured out of a range nobody parsed, so the declarations are not
  // consulted at all and the state is honestly unknown.
  const upstreamPythonRange =
    runtime === 'python'
      ? parsePythonRuntimeRange(
          requirement.requirement,
          requirement.kind === 'unsupported-runtime-range' ? 'unsupported' : 'minimum',
        )
      : null;
  if (requirement.rangeParseStatus === 'unknown' || upstreamPythonRange?.status === 'unknown') {
    return {
      changeId: change.id,
      runtime,
      requirement: requirement.requirement,
      state: 'unknown',
      reason: 'unparseable',
      declarations: [],
      unresolved: [],
      sites: [],
      statement: `${upstreamClause(requirement)}; Drift could not interpret that version range for ${RUNTIME_LABEL[runtime]}, so it could not determine compatibility.`,
    };
  }

  const discovery = discoverRuntimeDeclarations(files, runtime, member, allMembers);
  const declarations =
    requirement.kind === 'unsupported-runtime-range'
      ? checkUnsupportedRuntimeRange(runtime, discovery.resolved, requirement.requirement)
      : checkRuntimeCompatibility(runtime, discovery.resolved, requirement.requirement);

  const state = stateOf(declarations, discovery.unresolved);
  const reason = reasonFor(state, declarations, discovery.unresolved);

  return {
    changeId: change.id,
    runtime,
    requirement: requirement.requirement,
    state,
    reason,
    declarations,
    unresolved: discovery.unresolved,
    sites: sitesFor(change, runtime, declarations, discovery.unresolved, files),
    statement: describe(requirement, runtime, state, reason, declarations, discovery.unresolved),
  };
}

/**
 * Fold per-declaration verdicts into one answer for the workspace.
 *
 * Ordered by what a developer has to do about it, not by how many
 * declarations voted for it: one declaration that provably violates the
 * requirement is the answer even if six others satisfy it, because the build
 * that uses that one still breaks. `compatible` sits last and requires at
 * least one declaration to have actually been read — that is the whole
 * difference between "checked and fine" and "nothing looked".
 */
function stateOf(
  declarations: readonly RuntimeCompatibility[],
  unresolved: readonly UnresolvedRuntimeDeclaration[],
): RuntimeCompatibilityState {
  if (declarations.some((d) => d.verdict === 'incompatible')) return 'incompatible';
  if (declarations.some((d) => d.verdict === 'partial')) return 'partial';
  if (declarations.some((d) => d.verdict === 'unknown')) return 'unknown';
  if (unresolved.length > 0) return 'unknown';
  return declarations.length > 0 ? 'compatible' : 'unknown';
}

function reasonFor(
  state: RuntimeCompatibilityState,
  declarations: readonly RuntimeCompatibility[],
  unresolved: readonly UnresolvedRuntimeDeclaration[],
): RuntimeCompatibilityReason {
  if (state === 'incompatible') return 'violates';
  if (state === 'partial') return 'overlaps';
  if (state === 'compatible') return 'satisfies';
  if (declarations.some((d) => d.verdict === 'unknown')) return 'unparseable';
  if (unresolved.length > 0) return 'dynamic';
  return 'no-declaration';
}

/**
 * Impact sites, for the locations a developer can actually open.
 *
 * A `compatible` declaration produces none (there is nothing to fix), and a
 * `no-declaration` analysis produces none (there is nowhere to point). No
 * placeholder file, no synthetic line: the `unknown` state carries that fact
 * by itself, and inventing a site to carry it would put a location in the
 * report that does not exist.
 */
function sitesFor(
  change: BreakingChange,
  runtime: RuntimeName,
  declarations: readonly RuntimeCompatibility[],
  unresolved: readonly UnresolvedRuntimeDeclaration[],
  files: readonly { path: string; content: string }[],
): ImpactSite[] {
  const excerpt = (file: string, line: number) =>
    files.find((f) => f.path === file)?.content.split('\n')[line - 1]?.trim().slice(0, 200) ?? '';

  const sites: ImpactSite[] = [];
  for (const declaration of declarations) {
    if (declaration.verdict === 'compatible') continue;
    sites.push({
      breakingChangeId: change.id,
      file: declaration.file,
      line: declaration.line,
      excerpt: excerpt(declaration.file, declaration.line),
      matchedSymbol: runtime,
      // Identity confidence, not compatibility. Drift is sure this line is
      // this runtime's declaration; whether it satisfies the requirement is
      // `runtimeVerdict`'s job, and the two are deliberately not merged —
      // lowering confidence to express "partial" is what let a hedge about
      // meaning read as a hedge about whether the file was even found.
      confidence: declaration.verdict === 'unknown' ? 'low' : 'high',
      runtimeVerdict: declaration.verdict,
    });
  }

  for (const declaration of unresolved) {
    sites.push({
      breakingChangeId: change.id,
      file: declaration.file,
      line: declaration.line,
      excerpt: excerpt(declaration.file, declaration.line),
      matchedSymbol: runtime,
      confidence: 'low',
      runtimeVerdict: 'unknown',
    });
  }

  return sites;
}

const RUNTIME_LABEL: Record<RuntimeName, string> = {
  node: 'Node',
  python: 'Python',
  ruby: 'Ruby',
  go: 'Go',
  java: 'Java',
  rust: 'Rust',
};

/** "Upstream requires Node >=24" / "Upstream no longer supports Node 16.x". */
function upstreamClause(requirement: RuntimeRequirement): string {
  const label = RUNTIME_LABEL[requirement.runtime];
  return requirement.kind === 'minimum-runtime'
    ? `Upstream requires ${label} ${requirement.requirement}`
    : `Upstream no longer supports ${label} ${requirement.requirement}`;
}

/**
 * The sentence, matched to the state.
 *
 * Written here rather than at each consumer so the wording cannot drift from
 * the verdict it describes. In particular, nothing in this function can
 * produce "none of which this repository uses" — that claim requires
 * `compatible`, and `compatible` has its own sentence naming the declaration
 * that earned it.
 */
function describe(
  requirement: RuntimeRequirement,
  runtime: RuntimeName,
  state: RuntimeCompatibilityState,
  reason: RuntimeCompatibilityReason,
  declarations: readonly RuntimeCompatibility[],
  unresolved: readonly UnresolvedRuntimeDeclaration[],
): string {
  const label = RUNTIME_LABEL[runtime];
  const upstream = upstreamClause(requirement);
  const where = (list: readonly RuntimeDeclaration[]) =>
    [...new Set(list.map((d) => `${d.requirement} in ${d.file}`))].join(', ');

  if (state === 'compatible') {
    return `${upstream}; this repository declares ${label} ${where(declarations)}, which satisfies it.`;
  }

  if (state === 'incompatible') {
    const violating = declarations.filter((d) => d.verdict === 'incompatible');
    return `${upstream}; this repository declares ${label} ${where(violating)}.`;
  }

  if (state === 'partial') {
    const overlapping = declarations.filter((d) => d.verdict === 'partial');
    return `${upstream}; this repository allows ${where(overlapping)}, so its declared range includes versions this requirement rejects.`;
  }

  if (reason === 'dynamic') {
    return `${upstream}; ${describeSources(unresolved)} ${unresolved.length === 1 ? 'declares' : 'declare'} ${label} through a dynamic value, so Drift could not determine compatibility.`;
  }

  if (reason === 'unparseable') {
    const unreadable = declarations.filter((d) => d.verdict === 'unknown');
    return `${upstream}; this repository's ${label} declaration (${where(unreadable)}) is not a version range Drift could evaluate, so it could not determine compatibility.`;
  }

  if (reason === 'not-analyzed') {
    return `${upstream}; Drift did not complete localization, so runtime compatibility remains unknown.`;
  }

  return `${upstream}; Drift could not find an authoritative ${label} version declaration for this workspace.`;
}

const SOURCE_LABEL: Record<UnresolvedRuntimeDeclaration['source'], string> = {
  'version-file': 'a version file',
  manifest: 'the package manifest',
  container: 'a container image',
  ci: 'CI configuration',
  'tool-versions': '`.tool-versions`',
  'build-config': 'the build configuration',
};

function describeSources(unresolved: readonly UnresolvedRuntimeDeclaration[]): string {
  const named = [...new Set(unresolved.map((d) => `${SOURCE_LABEL[d.source]} (${d.file})`))];
  if (named.length === 1) return named[0]!;
  return `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`;
}

/**
 * The state a whole candidate should be judged by, across however many
 * runtime requirements it carries.
 *
 * `incompatible` beats `partial` beats `unknown` beats `compatible`, for the
 * same reason `stateOf` orders per-declaration verdicts that way: severity is
 * decided by the worst thing that is true, and `compatible` is the only one
 * of the four that is a clean bill of health. Returns `undefined` when there
 * were no runtime requirements at all — which is *not* `compatible`, and must
 * not be rendered as one.
 */
export function worstRuntimeState(
  analyses: readonly RuntimeRequirementAnalysis[] | undefined,
): RuntimeCompatibilityState | undefined {
  if (!analyses || analyses.length === 0) return undefined;
  const order: RuntimeCompatibilityState[] = ['incompatible', 'partial', 'unknown', 'compatible'];
  return order.find((state) => analyses.some((analysis) => analysis.state === state));
}

/**
 * Does runtime compatibility, by itself, forbid calling this upgrade safe?
 *
 * The single predicate every consumer asks — severity, the recommendation
 * ladder, and the recording validator — so the three cannot disagree about
 * what "unresolved" means.
 */
export function runtimeCompatibilityIsUnresolved(
  state: RuntimeCompatibilityState | undefined,
): boolean {
  return state === 'unknown' || state === 'partial';
}
