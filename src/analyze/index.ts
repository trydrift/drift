import type {
  BreakingChange,
  Confidence,
  DependencyChange,
  Evidence,
  StructuredFinding,
} from '../types.js';
import type { DriftConfig } from '../config/schema.js';
import type { Logger } from '../util/logger.js';
import { dependencyKey, stableId } from '../util/id.js';
import {
  kindForFindingCode,
  matchProse,
  remediationForFinding,
  remediationForProse,
  type ProseMatch,
} from './rules.js';
import { extractWithLlm } from './llm.js';
import { assessUpstream } from '../confidence/calibrate.js';
import { isSpecEvidenceSource } from '../evidence/spec/sources.js';
import { classify, taxonomyOf, type ChangeTaxonomy } from '../confidence/taxonomy.js';
import type { ConfidenceBand } from '../confidence/types.js';

/**
 * Turn evidence into breaking-change records.
 *
 * The central design constraint: a BreakingChange may never exist without at
 * least one Evidence citation. That invariant is what lets the PR say "here is
 * why" for every edit, and it is what a reviewer needs in order to approve a
 * change they did not write.
 */

export interface AnalyzeOptions {
  config: DriftConfig;
  logger: Logger;
}

export async function analyze(
  changes: readonly DependencyChange[],
  evidence: readonly Evidence[],
  options: AnalyzeOptions,
): Promise<BreakingChange[]> {
  const { config, logger } = options;
  const byDependency = groupEvidence(evidence);
  const results: BreakingChange[] = [];

  for (const change of changes) {
    const relevant = byDependency.get(dependencyKey(change)) ?? [];
    results.push(...analyzeDependency(change.name, change.workspace, relevant));
  }

  // Contract-document evidence is keyed by file path rather than a package
  // name, so it is not covered by the loop above. Asked of the registry rather
  // than named source by source, so a new format is picked up here for free.
  for (const record of evidence) {
    if (!isSpecEvidenceSource(record.source)) continue;
    results.push(...fromComputedEvidence(record));
  }

  if (config.llm.enabled) {
    const llmResults = await extractWithLlm(changes, evidence, results, { config, logger });
    results.push(...llmResults);
  }

  // Confidence is decided once, at the end, on the merged set — so a finding
  // several sources describe is scored with all of its citations in hand.
  return scoreUpstream(dedupe(results), evidence);
}

/**
 * Bucket evidence by the dependency it describes.
 *
 * Keyed by `dependencyKey` (workspace + name), not `record.dependency` alone —
 * otherwise two workspace members upgrading the same package to different
 * versions would each be handed the other's evidence too.
 */
function groupEvidence(evidence: readonly Evidence[]): Map<string, Evidence[]> {
  const byDependency = new Map<string, Evidence[]>();
  for (const record of evidence) {
    const key = dependencyKey({ name: record.dependency, workspace: record.workspace });
    const bucket = byDependency.get(key);
    if (bucket) bucket.push(record);
    else byDependency.set(key, [record]);
  }
  return byDependency;
}

function analyzeDependency(
  dependency: string,
  workspace: string | undefined,
  evidence: readonly Evidence[],
): BreakingChange[] {
  const out: BreakingChange[] = [];

  for (const record of evidence) {
    if (record.findings?.length) {
      out.push(...fromComputedEvidence(record));
      continue;
    }
    if (record.source === 'semver-heuristic' || record.source === 'registry-metadata') {
      continue; // Context, not a specific breaking change.
    }
    out.push(...fromProseEvidence(record, dependency, workspace));
  }

  return out;
}

/** Computed findings map one-to-one onto breaking changes; no inference needed. */
function fromComputedEvidence(record: Evidence): BreakingChange[] {
  return (record.findings ?? []).map((finding) => {
    const kind = kindForFindingCode(finding.code);
    const moduleSystem =
      kind === 'module-system-change'
        ? (finding.moduleSystem ?? { from: 'dual' as const, to: 'esm' as const, incompatibleUsage: ['require' as const] })
        : undefined;

    return {
      id: stableId(
        'bc',
        record.dependency,
        record.workspace,
        finding.code,
        finding.symbol,
        moduleSystem?.affectedSpecifiers?.join(',') ?? '',
      ),
      dependency: record.dependency,
      workspace: record.workspace,
      kind,
      summary: finding.detail,
      before: finding.before,
      after: finding.after,
      remediation: remediationForFinding(finding, record.dependency),
      symbols: symbolsFromFinding(finding),
      ...(moduleSystem
        ? {
            moduleSystem: {
              ...moduleSystem,
              incompatibleUsage: [...moduleSystem.incompatibleUsage],
              ...(moduleSystem.affectedSpecifiers
                ? { affectedSpecifiers: [...moduleSystem.affectedSpecifiers] }
                : {}),
            },
          }
        : {}),
      // Provisional; `scoreUpstream` decides the real value once citations are
      // merged. A computed diff is ground truth about the upstream artefact and
      // is the only class that reaches `high` uncorroborated.
      confidence: 'high' as Confidence,
      // The finding code names exactly what the differ observed, so this is the
      // one place a precise classification is available without inference.
      taxonomy: classify(kind, finding.code),
      citations: [record.id],
    };
  });
}

/**
 * Derive searchable symbols from a finding.
 *
 * For a member change like `Client.request`, the bare member name (`request`)
 * is useful alongside the qualified form: it catches destructured and aliased
 * usage the qualified form would miss. The leading component never becomes a
 * search symbol on its own, because a two-part symbol's first part cannot be
 * told apart from a bare namespace/package — `linux.WebviewGpuPolicyAlways`
 * has the identical shape as `Client.request`, and `linux` alone matched every
 * line that merely imported the package, so a repository whose only use of the
 * package was unrelated (`&linux.Options{}`, say) was reported as having two
 * sites affected by a constant it never referenced.
 *
 * Three or more parts means the leading one is a namespace, not an owner —
 * `unix.NexthopGrp.Resvd1` is a field of `NexthopGrp` in package `unix`. Adding
 * the namespace as a search symbol matched every line that used the package at
 * all, so a repository whose only Go call was `unix.Getpid()` was reported as
 * having three sites affected by a change to a netlink struct it never touches.
 * The owner is the second-to-last part; the leading namespace is never a symbol.
 */
function symbolsFromFinding(finding: StructuredFinding): string[] {
  if (kindForFindingCode(finding.code) === 'module-system-change') return [];

  const symbols = new Set<string>([finding.symbol]);

  // A symbol containing whitespace is a label, not an identifier — the counted
  // aggregate a provider emits when a hundred constants move at once. Splitting
  // `golang.org/x/sys constants` on its dots yielded `golang`, which matched the
  // import line of every file that used the module.
  if (finding.symbol.includes('.') && !/\s/.test(finding.symbol)) {
    const parts = finding.symbol.split('.');
    const last = parts[parts.length - 1];
    // The bare leaf earns its place only when it identifies something. A
    // language's universal method names do not: `_synctest.Todo.__init__`
    // contributed `__init__`, which matches the constructor of every class in
    // every file that imports the package, and Twisted alone turned a handful
    // of real removals into 229 reported sites — most of them `def
    // __init__(self):` in code that had never heard of `Todo`. The qualified
    // forms are still searched, so a genuine `Todo.__init__` reference is
    // still found; what is given up is aliased usage of a name so common that
    // matching it was never evidence of anything.
    if (last && !isGenericLeaf(last)) symbols.add(last);

    if (parts.length > 2) {
      // `unix.NexthopGrp.Resvd1` → also search `NexthopGrp.Resvd1`, which is how
      // the field is written wherever the package is imported under an alias.
      const owner = parts[parts.length - 2];
      if (owner) symbols.add(`${owner}.${last}`);
    }
  }

  // OpenAPI locations arrive as `GET /users/{id}`; the path alone is what
  // appears in client code.
  const endpoint = /^[A-Z]+\s+(\/\S*)$/.exec(finding.symbol);
  if (endpoint?.[1]) {
    symbols.add(endpoint[1]);
    // Client code usually interpolates the parameter rather than writing it
    // literally, so index on the static prefix too.
    const staticPrefix = endpoint[1].split('{')[0]?.replace(/\/$/, '');
    if (staticPrefix && staticPrefix.length > 1) symbols.add(staticPrefix);
  }

  return [...symbols];
}

/**
 * Names too common to be evidence on their own.
 *
 * Two families. Dunders are a language's universal protocol methods — every
 * Python class has `__init__`, so finding one says nothing about whether this
 * repository uses the symbol that changed. The rest are ordinary English words
 * that also happen to be method names: `define`, `match` and `send` each
 * matched prose in a docstring before this existed.
 *
 * Only ever applied to the *derived* bare leaf, never to the symbol a provider
 * actually reported. If upstream says `send` was removed, Drift still searches
 * for `send` — the finding named it, and second-guessing a provider's own
 * symbol would be a different and worse mistake.
 */
function isGenericLeaf(name: string): boolean {
  // `__init__`, `__call__`, `__enter__`, and every other dunder.
  if (/^__\w+__$/.test(name)) return true;
  return GENERIC_LEAF_NAMES.has(name.toLowerCase());
}

const GENERIC_LEAF_NAMES = new Set([
  // Verbs that are method names in every library ever written.
  'add', 'all', 'any', 'append', 'apply', 'build', 'call', 'check', 'clear',
  'clone', 'close', 'connect', 'copy', 'count', 'create', 'define', 'delete',
  'each', 'emit', 'end', 'execute', 'exists', 'extend', 'fetch', 'filter',
  'find', 'first', 'flush', 'format', 'get', 'handle', 'has', 'index', 'init',
  'insert', 'is', 'items', 'iter', 'join', 'keys', 'last', 'length', 'list',
  'load', 'log', 'main', 'map', 'match', 'new', 'next', 'open', 'parse', 'pop',
  'push', 'put', 'query', 'read', 'remove', 'render', 'reset', 'resolve', 'run',
  'save', 'send', 'set', 'size', 'sort', 'split', 'start', 'stop', 'update',
  'wait', 'write',
  // Nouns every codebase already has a local variable for. `root` came from
  // `maildir.AbstractMaildirDomain.root` and matched `root = Root()` in a
  // benchmark script with no maildir anywhere in it.
  //
  // Kept deliberately narrower than it could be. `request`, `response`,
  // `client` and `session` are just as common as locals, but they are also
  // plausible names for the actual thing a library exports, and dropping a
  // real API's only searchable short form costs a finding that matters. These
  // are the ones no library would name a distinctive export.
  'args', 'body', 'config', 'content', 'context', 'data', 'error', 'file',
  'header', 'headers', 'host', 'id', 'key', 'name', 'options', 'params', 'path',
  'port', 'result', 'root', 'status', 'text', 'type', 'url', 'value', 'values',
  // Keywords and conjunctions, in JS/TS, Python, and Ruby alike. A leaf named
  // `for` or `and` is never a real API — it is a `for` loop or the word "and"
  // in a sentence — but nothing above catches it: it is neither a dunder nor
  // a plausible method or local-variable name. `ts.server.protocol.for` and
  // `ts.server.protocol.and` (both TypeScript-internal types, not values)
  // reached this bare-leaf fallback and matched every loop and every "and" in
  // prose across an unrelated file before this existed.
  'and', 'or', 'not', 'if', 'elif', 'else', 'for', 'while', 'do', 'in', 'of',
  'as', 'with', 'from', 'to', 'try', 'catch', 'finally', 'throw',
  'raise', 'except', 'switch', 'case', 'break', 'continue', 'return', 'yield',
  'class', 'def', 'function', 'lambda', 'const', 'let', 'var', 'this', 'self',
  'super', 'null', 'nil', 'none', 'true', 'false', 'async', 'await', 'typeof',
  'instanceof', 'void', 'enum', 'interface', 'extends', 'implements',
  'export', 'import', 'static', 'public', 'private', 'protected', 'default',
  'pass', 'then',
]);

function fromProseEvidence(record: Evidence, dependency: string, workspace: string | undefined): BreakingChange[] {
  const out: BreakingChange[] = [];
  const seen = new Set<string>();

  for (const line of record.content.split('\n')) {
    for (const match of matchProse(line)) {
      const key = `${match.kind}:${match.symbols.join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Package-wide module-system changes name no export and must not be
      // localized by searching for the package name. They carry structured
      // loading semantics instead, so the localizer can find only incompatible
      // consumer forms such as `require()`.
      const symbols =
        match.symbols.length > 0 || match.kind === 'module-system-change' ? match.symbols : [dependency];

      out.push({
        id: stableId('bc', dependency, workspace, match.ruleId, match.symbols.join(',')),
        dependency,
        workspace,
        kind: match.kind,
        summary: match.summary,
        remediation: remediationForProse(match, dependency),
        symbols,
        replacementSymbols: match.replacementSymbols.length ? match.replacementSymbols : undefined,
        ...(match.moduleSystem ? { moduleSystem: match.moduleSystem } : {}),
        // Provisional; `scoreUpstream` decides the real value.
        confidence: confidenceForSource(record),
        taxonomy: classify(match.kind),
        citations: [record.id],
      });
    }
  }

  return out;
}

function confidenceForSource(record: Evidence): Confidence {
  if (record.weight >= 0.95) return 'high';
  if (record.weight >= 0.6) return 'medium';
  return 'low';
}

/**
 * Score every finding against its own citations.
 *
 * Runs after `dedupe`, so a finding that several sources describe is scored
 * once with all of its citations rather than scored separately and merged.
 *
 * This replaces a `corroborate` pass that had two defects. It pooled sources
 * across every finding sharing any symbol, so one well-corroborated finding
 * promoted unrelated ones that happened to mention the same identifier. And it
 * counted `EvidenceSource` values as independent, which they are not: a GitHub
 * release body and a CHANGELOG entry are routinely the same text published
 * twice, and counting them as two agreeing sources took a single unverified
 * maintainer sentence to `high`.
 *
 * `assessUpstream` groups by origin class and collapses byte-identical content,
 * so corroboration now requires genuinely independent observation.
 */
function scoreUpstream(
  changes: readonly BreakingChange[],
  evidence: readonly Evidence[],
): BreakingChange[] {
  return changes.map((change) => {
    const upstream = assessUpstream({ change, evidence });
    return { ...change, confidence: bandToLegacy(upstream.band) };
  });
}

function bandToLegacy(band: ConfidenceBand): Confidence {
  return band === 'high' ? 'high' : band === 'medium' ? 'medium' : 'low';
}

/**
 * Merge duplicate records, unioning their citations.
 *
 * The same removal legitimately appears in a release note, the changelog, and
 * the type diff. A reviewer should see one finding with three sources, not
 * three findings.
 */
function dedupe(changes: readonly BreakingChange[]): BreakingChange[] {
  const merged = new Map<string, BreakingChange>();

  for (const change of changes) {
    const key = dedupeKey(change);
    const existing = merged.get(key);

    if (!existing) {
      merged.set(key, { ...change, citations: [...new Set(change.citations)] });
      continue;
    }

    merged.set(key, {
      ...existing,
      // Prefer the more specific summary; computed findings are more precise
      // than a changelog sentence and tend to be longer.
      summary: existing.summary.length >= change.summary.length ? existing.summary : change.summary,
      symbols: [...new Set([...existing.symbols, ...change.symbols])],
      replacementSymbols: [
        ...new Set([...(existing.replacementSymbols ?? []), ...(change.replacementSymbols ?? [])]),
      ].filter(Boolean).length
        ? [...new Set([...(existing.replacementSymbols ?? []), ...(change.replacementSymbols ?? [])])]
        : undefined,
      moduleSystem: mergeModuleSystem(existing.moduleSystem, change.moduleSystem),
      confidence: maxConfidence(existing.confidence, change.confidence),
      // The more precisely-derived classification wins. A computed differ knows
      // exactly what it saw; a prose rule inferred it from a sentence.
      taxonomy: preferSpecificTaxonomy(taxonomyOf(existing), taxonomyOf(change)),
      citations: [...new Set([...existing.citations, ...change.citations])],
    });
  }

  const order: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };
  return [...merged.values()].sort(
    (a, b) => order[a.confidence] - order[b.confidence] || a.dependency.localeCompare(b.dependency),
  );
}

function dedupeKey(change: BreakingChange): string {
  const dependency = dependencyKey({ name: change.dependency, workspace: change.workspace });
  if (change.kind === 'module-system-change') {
    return [
      dependency,
      change.kind,
      [...(change.moduleSystem?.incompatibleUsage ?? [])].sort().join(','),
      change.moduleSystem?.affectedSpecifiers?.length
        ? [...change.moduleSystem.affectedSpecifiers].sort().join(',')
        : '*',
    ].join('|');
  }
  return `${dependency}|${change.kind}|${[...change.symbols].sort().join(',')}`;
}

function mergeModuleSystem(
  a: BreakingChange['moduleSystem'],
  b: BreakingChange['moduleSystem'],
): BreakingChange['moduleSystem'] | undefined {
  if (!a) return b;
  if (!b) return a;

  const incompatibleUsage = [...new Set([...a.incompatibleUsage, ...b.incompatibleUsage])];
  const affected =
    a.affectedSpecifiers || b.affectedSpecifiers
      ? [...new Set([...(a.affectedSpecifiers ?? []), ...(b.affectedSpecifiers ?? [])])]
      : undefined;

  return {
    from: a.from ?? b.from,
    to: a.to ?? b.to,
    incompatibleUsage,
    ...(affected ? { affectedSpecifiers: affected } : {}),
  };
}

/** `computed` beats `rule` beats `llm-normalized` beats `default`. */
function preferSpecificTaxonomy(a: ChangeTaxonomy, b: ChangeTaxonomy): ChangeTaxonomy {
  const rank: Record<ChangeTaxonomy['origin'], number> = {
    computed: 3,
    rule: 2,
    'llm-normalized': 1,
    default: 0,
  };
  return rank[a.origin] >= rank[b.origin] ? a : b;
}

function maxConfidence(a: Confidence, b: Confidence): Confidence {
  const rank: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
  return rank[a] >= rank[b] ? a : b;
}

export function meetsConfidence(actual: Confidence, minimum: Confidence): boolean {
  const rank: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
  return rank[actual] >= rank[minimum];
}

export * from './rules.js';
export type { ProseMatch };
