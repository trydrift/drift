import type { BreakingChangeKind, ModuleIncompatibleUsage, StructuredFinding } from '../types.js';
import { specCodeFor } from '../evidence/spec/index.js';

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
  // Contract-document formats (OpenAPI, protobuf, GraphQL) answer for their own
  // codes, next to the differ that emits them — see `evidence/spec/types.ts`.
  const spec = specCodeFor(code);
  if (spec) return spec.kind;

  switch (code) {
    case 'export-removed':
      return 'removed-export';
    case 'member-removed':
      return 'removed-export';
    case 'signature-changed':
      return 'signature-change';
    // A constant's value changing is not a callable's contract changing —
    // grouped with signature-change for scoring and commit planning, but see
    // `remediationForFinding` for why it gets its own remediation text.
    case 'constant-value-changed':
      return 'signature-change';
    case 'kind-changed':
      return 'type-change';
    case 'member-now-required':
      return 'required-field-added';
    case 'entry-point-moved':
    case 'package-removed':
      return 'moved-export';
    case 'commonjs-entry-removed':
    case 'exports-require-condition-removed':
    case 'package-type-changed':
      return 'module-system-change';

    default:
      return 'unknown';
  }
}

/** Imperative remediation text for a computed finding. Fed to the agent verbatim. */
export function remediationForFinding(finding: StructuredFinding, dependency: string): string {
  const { code, symbol } = finding;

  // As with `kindForFindingCode`: a contract format owns the wording for its
  // own codes, so a new format ships its remediation text with its differ.
  const spec = specCodeFor(code);
  if (spec) return spec.remediation(finding);

  switch (code) {
    case 'export-removed':
      return `Every use of \`${symbol}\` from \`${dependency}\` must be replaced. Find the supported replacement in the new version's exports and migrate each call site. Do not stub \`${symbol}\` out or re-implement it locally unless no replacement exists — if none exists, say so in the PR description rather than inventing one.`;
    case 'member-removed':
      return `The member \`${symbol}\` no longer exists in \`${dependency}\`. Update each access to use the replacement member, or restructure the calling code if the capability was removed outright.`;
    case 'signature-changed':
      // Before/after are already shown as their own diff block above this
      // text (see renderBreak / report/markdown.ts) — repeating them here
      // just says the same thing twice. What is worth adding instead is what
      // `finding.changed` knows and a raw diff cannot say by itself: which
      // half of the contract moved, and — for the return-type case
      // specifically — whether the calling language would even catch it.
      switch (finding.changed) {
        case 'parameters':
          return `The parameters of \`${symbol}\` changed; its return type did not. Update every call site to pass arguments matching the new list — check argument order, argument count, and whether an options object replaced positional arguments. A call that only reads the result of \`${symbol}\` needs no change beyond its arguments.`;
        case 'return-type':
          return `The return type of \`${symbol}\` changed; its parameters did not, so no call site needs its arguments touched. What changed is what a caller gets back. In a statically typed language, a call site that assigns or passes the result on will fail to compile and point you straight at the fix; nothing here needs a source change beyond letting the type checker find those. In a dynamically typed one (plain JavaScript, Python, Ruby), nothing will catch this automatically — search for call sites that store, destructure, or pass along the result of \`${symbol}\` and check each one against the new type by hand.`;
        case 'both':
          return `Both the parameters and the return type of \`${symbol}\` changed. Update every call site's arguments to match the new parameter list, then separately check what each call site does with the result: a statically typed caller will have a mismatched return type caught by its own compiler, a dynamically typed one will not.`;
        default:
          return `The signature of \`${symbol}\` changed. Update every call site to match the new signature exactly. Pay attention to argument order, argument count, and whether an options object replaced positional arguments.`;
      }
    case 'constant-value-changed':
      // Not a call site to rewrite: the constant's name and type are
      // unchanged, so code that only ever refers to it by name keeps
      // compiling and behaving correctly. What can break silently is code
      // that depends on the concrete number underneath — a hard-coded copy of
      // the old value, a serialized/persisted form, or a check against zero.
      // Before/after are shown as their own diff block above this text.
      return `\`${symbol}\` changed underlying value. This does not necessarily require a source change — most code that only refers to \`${symbol}\` by name keeps working. Review code in this repository that depends on the concrete value: a hard-coded copy of the old number, a value persisted or sent over the wire, or a comparison against zero or another literal.`;
    case 'kind-changed':
      return kindChangeRemediation(symbol, finding.fromKind, finding.toKind);
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
    case 'commonjs-entry-removed':
    case 'exports-require-condition-removed':
    case 'package-type-changed':
      return `\`${dependency}\` no longer exposes the CommonJS loading compatibility it exposed before. Update each localized \`require('${dependency}')\` site to use an ESM-compatible loading mechanism, usually a static \`import\` in an ESM module or a dynamic \`await import('${dependency}')\` where the surrounding CommonJS file cannot move. Do not downgrade the dependency, and do not convert the whole repository to ESM unless that is already the intended migration path.`;

    default:
      return `Review usages of \`${symbol}\` from \`${dependency}\` and update them for the new version.`;
  }
}

/**
 * What actually has to change at a call site for one specific pair of
 * declaration shapes.
 *
 * "Update declarations, `new` expressions, and type positions accordingly"
 * is true for every pair and useful for none of them — the fix for "class
 * became a function" (drop every `new`) is the opposite of the fix for
 * "function became a class" (add `new` everywhere), and neither is
 * discoverable from the generic sentence. Falls back to the general form
 * only for the one direction — anything through `interface`/`type`, which
 * are positions, not values, and have no construction syntax to correct.
 */
function kindChangeRemediation(symbol: string, fromKind: string | undefined, toKind: string | undefined): string {
  if (fromKind === 'class' && toKind === 'function') {
    return `\`${symbol}\` is no longer a class — it is a function now. Remove \`new\` from every construction site (\`new ${symbol}(...)\` becomes \`${symbol}(...)\`); calling it without \`new\` on the old version would have thrown or behaved differently, so every call site necessarily used \`new\` and necessarily needs it removed. Anything that did \`instanceof ${symbol}\` on the result has no replacement to fall back on automatically — check what it was actually testing for.`;
  }
  if (fromKind === 'function' && toKind === 'class') {
    return `\`${symbol}\` is a class now, not a function. Add \`new\` at every call site (\`${symbol}(...)\` becomes \`new ${symbol}(...)\`); calling a class without \`new\` throws in JavaScript, so this is a hard requirement, not a style choice.`;
  }
  if ((fromKind === 'interface' || fromKind === 'type') && toKind === 'class') {
    return `\`${symbol}\` is a class now, not just a type. Nothing changes for code that only used it as a type annotation — but if this repository ever constructed a value shaped like it by hand (an object literal, a factory function), that code should now go through \`new ${symbol}(...)\` if the class provides real behaviour a plain object cannot.`;
  }
  if (fromKind === 'class' && (toKind === 'interface' || toKind === 'type')) {
    return `\`${symbol}\` is a plain type now, not a class. Replace every \`new ${symbol}(...)\` with however the package now wants this value built. Remove any \`instanceof ${symbol}\` check — there is no runtime class left to test against; if the value's presence still needs checking, do a structural check on its fields instead.`;
  }
  if (fromKind === 'namespace' || toKind === 'namespace') {
    return `\`${symbol}\` moved between a namespace and a ${fromKind === 'namespace' ? toKind : fromKind}. Update every access through \`${symbol}.\` to match how its members are reached in the new form, and update any type position that named \`${symbol}\` directly.`;
  }
  return `\`${symbol}\` changed from a ${fromKind ?? 'previous form'} to a ${toKind ?? 'different form'}. Update declarations, \`new\` expressions, and type positions accordingly.`;
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
  moduleSystem?: {
    from?: 'commonjs' | 'esm' | 'dual';
    to?: 'commonjs' | 'esm' | 'dual';
    incompatibleUsage: ModuleIncompatibleUsage[];
  };
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
    kind: 'module-system-change',
    pattern:
      /\b(?:this|the)\s+(?:package|project|library|module)\s+(?:is\s+)?now\s+(?:pure\s+ESM|ESM[\s-]only|an?\s+ESM\s+package)\b|\b(?:migrated|converted|switched)\s+(?:this|the)\s+(?:package|project|library|module)\s+to\s+ESM\b/i,
    symbolGroup: 0,
    summarize: () => 'The package is now ESM-only and no longer supports `require()`',
    moduleSystem: { from: 'dual', to: 'esm', incompatibleUsage: ['require'] },
  },
  {
    id: 'prose-dropped-commonjs',
    kind: 'module-system-change',
    pattern:
      /\b(?:dropped|removed)\s+CommonJS\s+support\b|\b(?:dropped|removed|no longer (?:supports|provides))\s+CommonJS\b|\bCommonJS\s+(?:is\s+)?no\s+longer\s+supported\b|\brequire\(\)\s+(?:is\s+)?no\s+longer\s+supported\b/i,
    symbolGroup: 0,
    summarize: () => 'CommonJS support was dropped',
    moduleSystem: { from: 'dual', to: 'esm', incompatibleUsage: ['require'] },
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
  moduleSystem?: {
    from?: 'commonjs' | 'esm' | 'dual';
    to?: 'commonjs' | 'esm' | 'dual';
    incompatibleUsage: ModuleIncompatibleUsage[];
  };
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
      ...(rule.moduleSystem
        ? {
            moduleSystem: {
              ...rule.moduleSystem,
              incompatibleUsage: [...rule.moduleSystem.incompatibleUsage],
            },
          }
        : {}),
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
    case 'module-system-change':
      return `\`${dependency}\` no longer exposes a CommonJS-compatible entry point. Update each localized \`require('${dependency}')\` site to use an ESM-compatible loading mechanism, usually a static \`import\` in an ESM module or a dynamic \`await import('${dependency}')\` where the surrounding CommonJS file cannot move. Do not downgrade the dependency, and do not convert the whole repository to ESM unless that is already the intended migration path.`;
    case 'config-change':
      return `Configuration must change: ${match.summary}.`;
    default:
      return `Review usages of \`${symbol}\` and update them: ${match.summary}`;
  }
}
