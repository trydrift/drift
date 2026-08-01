import type { BreakingChangeKind, StructuredFinding } from '../types.js';

/**
 * Deterministic mapping from computed findings and changelog prose to
 * breaking-change records.
 *
 * The rule engine runs first and unconditionally. An LLM pass is available for
 * prose recall, but Drift's core claim — that it can be trusted to edit a
 * production repo — rests on the fact that its highest-confidence conclusions
 * come from code that anyone can read and step through, not from a model.
 */

/** Map a computed finding code onto Drift's fix-strategy taxonomy. */
export function kindForFindingCode(code: string): BreakingChangeKind {
  switch (code) {
    case 'export-removed':
      return 'removed-export';
    case 'member-removed':
      return 'removed-export';
    case 'signature-changed':
      return 'signature-change';
    case 'kind-changed':
      return 'type-change';
    case 'member-now-required':
      return 'required-field-added';
    case 'entry-point-moved':
    case 'package-removed':
      return 'moved-export';

    case 'path-removed':
    case 'operation-removed':
    case 'response-status-removed':
      return 'removed-endpoint';
    case 'parameter-removed':
    case 'parameter-type-changed':
    case 'response-field-removed':
    case 'response-field-type-changed':
    case 'request-field-type-changed':
    case 'request-enum-narrowed':
    case 'response-enum-widened':
      return 'changed-endpoint';
    case 'parameter-now-required':
    case 'request-field-now-required':
      return 'required-field-added';
    case 'security-added':
      return 'config-change';

    default:
      return 'unknown';
  }
}

/** Imperative remediation text for a computed finding. Fed to the agent verbatim. */
export function remediationForFinding(finding: StructuredFinding, dependency: string): string {
  const { code, symbol } = finding;

  switch (code) {
    case 'export-removed':
      return `Every use of \`${symbol}\` from \`${dependency}\` must be replaced. Find the supported replacement in the new version's exports and migrate each call site. Do not stub \`${symbol}\` out or re-implement it locally unless no replacement exists — if none exists, say so in the PR description rather than inventing one.`;
    case 'member-removed':
      return `The member \`${symbol}\` no longer exists in \`${dependency}\`. Update each access to use the replacement member, or restructure the calling code if the capability was removed outright.`;
    case 'signature-changed':
      return `The signature of \`${symbol}\` changed. Update every call site to match the new signature exactly. Pay attention to argument order, argument count, and whether an options object replaced positional arguments.\n  before: ${finding.before ?? '(unknown)'}\n  after:  ${finding.after ?? '(unknown)'}`;
    case 'kind-changed':
      return `\`${symbol}\` changed form (for example class to function, or interface to type alias). Update declarations, \`new\` expressions, and type positions accordingly.`;
    case 'entry-point-moved':
      // Deliberately forbids the per-symbol fix. An agent told only that a
      // hundred symbols vanished will replace them one at a time with things it
      // invented; the actual change is one line at the top of each file.
      return `The import path changed, not the API. ${finding.detail} Update the import specifier in every file that imports from \`${dependency}\`, and do not replace, stub, or re-implement the individual symbols — they still exist under the new entry point. If you cannot determine which entry point carries a symbol this repository uses, leave that import alone with a \`TODO(drift):\` comment naming the symbol.`;
    case 'package-removed':
      // Same prohibition as `entry-point-moved`, for the same reason: the
      // symbols did not individually disappear, their home did.
      return `The package \`${symbol}\` no longer exists in \`${dependency}\`. Update the import path in every file that imports it to whichever package now provides the same API. Do not re-implement or stub the symbols it exported — if you cannot determine the replacement package, leave the import in place with a \`TODO(drift):\` comment naming it rather than guessing.`;
    case 'member-now-required':
      return `\`${symbol}\` is now required. Supply an explicit value at every construction site. Choose the value that preserves the previous default behaviour; if the previous default is not documented, leave a TODO and flag it in the PR description rather than guessing.`;

    case 'path-removed':
    case 'operation-removed':
      return `The endpoint \`${symbol}\` no longer exists. Locate the client code that calls it and migrate to the replacement endpoint. If there is no replacement, do not delete the feature — leave the call site intact with a clearly-marked TODO and explain it in the PR description.`;
    case 'response-status-removed':
      return `\`${symbol}\` no longer returns this success status. Update response handling so the removed status is no longer treated as a success path.`;
    case 'parameter-removed':
      return `A required parameter was removed from \`${symbol}\`. Remove it from client calls; sending it may now be rejected as an unexpected parameter.`;
    case 'parameter-now-required':
    case 'request-field-now-required':
      return `\`${symbol}\` now requires this field. Add it to every request built in this repo, using a value consistent with the surrounding code's intent.`;
    case 'parameter-type-changed':
    case 'request-field-type-changed':
      return `The request type for \`${symbol}\` changed. Update serialisation at each call site so the value sent matches the new type.`;
    case 'response-field-removed':
      return `\`${symbol}\` no longer returns this field. Update every reader of that field. If the value is genuinely no longer available, propagate the absence properly rather than substituting a placeholder that could be mistaken for real data.`;
    case 'response-field-type-changed':
      return `The response type for \`${symbol}\` changed. Update parsing and any downstream type declarations.`;
    case 'request-enum-narrowed':
      return `\`${symbol}\` no longer accepts some previously-valid values. Find code that sends the removed values and map them onto still-supported ones.`;
    case 'response-enum-widened':
      return `\`${symbol}\` can now return values this code has never seen. Add explicit handling; make sure exhaustive switches and mapping tables have a safe default rather than falling through silently.`;
    case 'security-added':
      return `\`${symbol}\` now requires authentication. Ensure the client attaches credentials for this call, reusing the repo's existing auth mechanism — never introduce a new credential source or hard-code a token.`;

    default:
      return `Review usages of \`${symbol}\` from \`${dependency}\` and update them for the new version.`;
  }
}

/** One prose pattern that recognises a breaking change and names the symbols. */
interface ProseRule {
  id: string;
  kind: BreakingChangeKind;
  pattern: RegExp;
  /** Builds the summary from the regex match. */
  summarize: (m: RegExpMatchArray) => string;
  /**
   * Capture-group index holding the affected symbol.
   *
   * `0` is a sentinel meaning "this change has no symbol" — package-wide
   * changes like an ESM migration break consumers without touching a single
   * export name. The caller substitutes the dependency name so localization
   * can still find the import sites.
   */
  symbolGroup: number;
  /** Replacement symbol group index, for renames. */
  replacementGroup?: number;
}

/**
 * Prose rules.
 *
 * These only fire on *backtick-quoted* identifiers. That restriction is the
 * whole reason this is usable: maintainers consistently code-format API names
 * in changelogs, and requiring the backticks is what keeps us from extracting
 * ordinary English words as symbols and sending an agent chasing them.
 */
const PROSE_RULES: ProseRule[] = [
  {
    id: 'prose-removed',
    kind: 'removed-export',
    pattern: /`([\w$.]+)`(?:\(\))?\s+(?:has been|have been|was|were|is|are)\s+removed\b/i,
    symbolGroup: 1,
    summarize: (m) => `\`${m[1]}\` was removed`,
  },
  {
    id: 'prose-removed-passive',
    kind: 'removed-export',
    pattern: /\bremoved\s+(?:the\s+)?`([\w$.]+)`/i,
    symbolGroup: 1,
    summarize: (m) => `\`${m[1]}\` was removed`,
  },
  {
    id: 'prose-renamed',
    kind: 'renamed-export',
    pattern: /`([\w$.]+)`\s+(?:has been |was |is )?renamed\s+to\s+`([\w$.]+)`/i,
    symbolGroup: 1,
    replacementGroup: 2,
    summarize: (m) => `\`${m[1]}\` was renamed to \`${m[2]}\``,
  },
  {
    id: 'prose-replaced',
    kind: 'renamed-export',
    pattern: /`([\w$.]+)`\s+(?:has been |was |is )?replaced\s+(?:by|with)\s+`([\w$.]+)`/i,
    symbolGroup: 1,
    replacementGroup: 2,
    summarize: (m) => `\`${m[1]}\` was replaced by \`${m[2]}\``,
  },
  {
    id: 'prose-deprecated-in-favour',
    kind: 'renamed-export',
    pattern: /`([\w$.]+)`\s+is\s+deprecated\s+in\s+favou?r\s+of\s+`([\w$.]+)`/i,
    symbolGroup: 1,
    replacementGroup: 2,
    summarize: (m) => `\`${m[1]}\` is deprecated in favour of \`${m[2]}\``,
  },
  {
    /**
     * The verb rarely follows the symbol directly.
     *
     * Maintainers write "`$defs` entries no longer include a redundant `id`"
     * and "`z.union([])` and discriminated unions no longer crash", not
     * "`x` no longer y". Requiring adjacency meant zod's own release notes —
     * the ones Drift did fetch — produced no findings at all. Up to three
     * intervening words is enough for the noun phrases that actually occur,
     * and short enough that the symbol still governs the sentence.
     */
    id: 'prose-no-longer',
    kind: 'behaviour-change',
    pattern: /`([\w$.]+)(?:\([^`]*\))?`(?:\(\))?(?:[\w\s,`()[\]{}$.]{0,40}?)\s+no\s+longer\s+(.{3,90}?)(?:[.;]|$)/i,
    symbolGroup: 1,
    summarize: (m) => `\`${m[1]}\` no longer ${m[2]?.trim()}`,
  },
  {
    id: 'prose-now-requires',
    kind: 'signature-change',
    pattern: /`([\w$.]+)(?:\([^`]*\))?`(?:\(\))?(?:[\w\s,`()[\]{}$.]{0,40}?)\s+now\s+(?:requires|takes|accepts|expects)\s+(.{3,90}?)(?:[.;]|$)/i,
    symbolGroup: 1,
    summarize: (m) => `\`${m[1]}\` now requires ${m[2]?.trim()}`,
  },
  {
    id: 'prose-now-returns',
    kind: 'type-change',
    pattern: /`([\w$.]+)(?:\([^`]*\))?`(?:\(\))?(?:[\w\s,`()[\]{}$.]{0,40}?)\s+now\s+returns\s+(.{3,90}?)(?:[.;]|$)/i,
    symbolGroup: 1,
    summarize: (m) => `\`${m[1]}\` now returns ${m[2]?.trim()}`,
  },
  {
    /**
     * "`x` must now be …" / "`x` is now …" — the same statement in the other
     * voice, and just as common in practice.
     */
    id: 'prose-is-now',
    kind: 'behaviour-change',
    pattern: /`([\w$.]+)(?:\([^`]*\))?`(?:\(\))?(?:[\w\s,`()[\]{}$.]{0,40}?)\s+(?:is|are|must)\s+now\s+(.{3,90}?)(?:[.;]|$)/i,
    symbolGroup: 1,
    summarize: (m) => `\`${m[1]}\` is now ${m[2]?.trim()}`,
  },
  {
    id: 'prose-moved',
    kind: 'renamed-export',
    pattern: /`([\w$.]+)`\s+(?:has\s+)?moved\s+to\s+`([\w$./@-]+)`/i,
    symbolGroup: 1,
    replacementGroup: 2,
    summarize: (m) => `\`${m[1]}\` moved to \`${m[2]}\``,
  },
  {
    // `required` as well as `requires`: real release notes say
    // "**Required Node.js >=14.16**", not "now requires Node.js".
    id: 'prose-min-runtime',
    kind: 'runtime-requirement',
    pattern:
      /\b(?:requires?|required|now requires?|minimum(?: supported)?)\s+(node(?:\.js)?|python|go|ruby|java|rust)\s*(?:version\s*)?([>=^~]*\s*[\d.]+)/i,
    symbolGroup: 1,
    summarize: (m) => `Minimum ${m[1]} version raised to ${m[2]?.trim()}`,
  },
  {
    /**
     * ESM-only migration.
     *
     * This breaks every CommonJS consumer without renaming a single export,
     * so no symbol-based rule can catch it. Maintainers announce it as a
     * statement of fact — "This package is now pure ESM" — which is why it
     * needs a rule of its own rather than falling out of the removal patterns.
     */
    id: 'prose-esm-only',
    kind: 'config-change',
    pattern: /\b(?:is now |now )?(?:pure ESM|ESM[\s-]only|ESM package)\b/i,
    symbolGroup: 0,
    summarize: () => 'The package is now ESM-only and no longer supports `require()`',
  },
  {
    id: 'prose-dropped-commonjs',
    kind: 'config-change',
    pattern: /\b(?:dropped|removed|no longer (?:supports|provides))\s+CommonJS\b/i,
    symbolGroup: 0,
    summarize: () => 'CommonJS support was dropped',
  },
  {
    id: 'prose-dropped-support',
    kind: 'runtime-requirement',
    pattern: /\b(?:dropped|drops|removed)\s+support\s+for\s+(.{3,60}?)(?:[.;]|$)/i,
    symbolGroup: 1,
    summarize: (m) => `Dropped support for ${m[1]?.trim()}`,
  },
];

export interface ProseMatch {
  ruleId: string;
  kind: BreakingChangeKind;
  summary: string;
  symbols: string[];
  replacementSymbols: string[];
  /** The line the match came from, kept verbatim for the report. */
  passage: string;
}

/** Run every prose rule over a single changelog/release-note line. */
export function matchProse(passage: string): ProseMatch[] {
  const out: ProseMatch[] = [];
  const text = passage.replace(/^[-*+]\s+/, '').trim();
  if (!text) return out;

  for (const rule of PROSE_RULES) {
    const match = rule.pattern.exec(text);
    if (!match) continue;

    // Group 0 marks a package-wide change; anything else must actually capture.
    const symbol = rule.symbolGroup === 0 ? null : match[rule.symbolGroup];
    if (rule.symbolGroup !== 0 && !symbol) continue;

    const replacement = rule.replacementGroup ? match[rule.replacementGroup] : undefined;

    out.push({
      ruleId: rule.id,
      kind: rule.kind,
      summary: rule.summarize(match),
      symbols: symbol ? [symbol] : [],
      replacementSymbols: replacement ? [replacement] : [],
      passage: text,
    });
  }

  return out;
}

/** Remediation text for a prose-derived change. */
export function remediationForProse(match: ProseMatch, dependency: string): string {
  const symbol = match.symbols[0] ?? 'the affected API';
  const replacement = match.replacementSymbols[0];

  switch (match.kind) {
    case 'removed-export':
      return `\`${symbol}\` was removed from \`${dependency}\`. Replace every usage. Verify against the installed version's actual exports before choosing a replacement — the changelog may be incomplete.`;
    case 'renamed-export':
      return replacement
        ? `Replace every usage of \`${symbol}\` with \`${replacement}\`, checking that the new API's signature matches before assuming it is a drop-in rename.`
        : `\`${symbol}\` was replaced. Migrate every usage to the documented successor.`;
    case 'signature-change':
      return `The way \`${symbol}\` is called changed: ${match.summary}. Update every call site and confirm against the installed type declarations.`;
    case 'type-change':
      return `The type produced by \`${symbol}\` changed: ${match.summary}. Update consumers of its return value, including any local type declarations.`;
    case 'behaviour-change':
      return `Behaviour changed: ${match.summary}. Review call sites for assumptions that no longer hold. Prefer making the assumption explicit over silently adapting to the new behaviour.`;
    case 'runtime-requirement':
      return `${match.summary}. Update the runtime version declared in CI workflows, engine fields, and container images. Do not change application logic for this.`;
    case 'config-change':
      if (match.ruleId === 'prose-esm-only' || match.ruleId === 'prose-dropped-commonjs') {
        return `\`${dependency}\` is now ESM-only. Every \`require('${dependency}')\` must become a static \`import\`, and the importing files must themselves be ESM. If this repository is CommonJS, the smallest correct change is usually a dynamic \`await import('${dependency}')\` at the call site — do NOT downgrade the dependency, and do NOT convert the whole repository to ESM as part of this fix. If neither option works cleanly, stop and explain the situation in the pull request description rather than forcing it.`;
      }
      return `Configuration must change: ${match.summary}.`;
    default:
      return `Review usages of \`${symbol}\` and update them: ${match.summary}`;
  }
}
