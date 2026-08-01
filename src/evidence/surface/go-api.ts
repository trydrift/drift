import type { SurfaceChange } from '../type-surface.js';

/**
 * Comparing two Go module versions' exported APIs.
 *
 * The extractor hands back every exported symbol of every importable package,
 * per platform. This module turns two of those into the findings a developer
 * can act on, and it is where the judgement lives — which is to say, where the
 * decisions about *what not to report* live.
 *
 * Three of them are worth stating outright:
 *
 *   - A removed package is reported once, and the hundreds of symbol removals
 *     underneath it are suppressed. A reader shown four hundred missing
 *     symbols reaches for four hundred fixes; a reader told the package is
 *     gone reaches for the right one.
 *   - A method or field that vanished with nothing else is reported through
 *     its owning type, not twice.
 *   - Constants changing value are real and are reported, but a platform
 *     header regeneration moves dozens at once, so past a threshold they
 *     collapse into one counted finding instead of burying everything else.
 */

export interface GoSymbol {
  key: string;
  name: string;
  pkg: string;
  pkgName: string;
  kind: string;
  signatures: string[];
  members: string[];
  requiredMembers: string[];
  platforms: string[];
}

export interface GoPackageFailure {
  pkg: string;
  error: string;
}

export interface GoApi {
  module: string;
  packages: string[];
  symbols: Map<string, GoSymbol>;
  failures: GoPackageFailure[];
  platforms: string[];
}

/** Something the new version gained. Never breaking; used to justify an upgrade. */
export interface GoAddition {
  kind: 'package-added' | 'export-added';
  symbol: string;
}

/**
 * Read the extractor's JSON.
 *
 * Returns `null` rather than throwing on anything unexpected: a toolchain that
 * printed a warning onto stdout is a parse failure with a stated reason, not a
 * crashed scan.
 */
export function parseGoApiDump(output: string): GoApi | null {
  let raw: unknown;
  try {
    raw = JSON.parse(output.trim());
  } catch {
    return null;
  }

  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  if (!Array.isArray(data.Symbols) || !Array.isArray(data.Packages)) return null;

  const symbols = new Map<string, GoSymbol>();
  for (const entry of data.Symbols as Record<string, unknown>[]) {
    const key = typeof entry.Key === 'string' ? entry.Key : null;
    if (!key) continue;
    symbols.set(key, {
      key,
      name: str(entry.Name),
      pkg: str(entry.Pkg),
      pkgName: str(entry.PkgName),
      kind: str(entry.Kind) || 'variable',
      signatures: list(entry.Signatures),
      members: list(entry.Members),
      requiredMembers: list(entry.RequiredMembers),
      platforms: list(entry.Platforms),
    });
  }

  return {
    module: str(data.Module),
    packages: list(data.Packages),
    symbols,
    failures: Array.isArray(data.Failures)
      ? (data.Failures as Record<string, unknown>[]).map((f) => ({
          pkg: str(f.Pkg),
          error: str(f.Error),
        }))
      : [],
    platforms: list(data.Platforms),
  };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Past this many constants changing value, they are reported as a count.
 *
 * Regenerating `zerrors_linux_amd64.go` moves a hundred constants in one
 * release. Every one of them is a true finding and none of them is the reason
 * anyone is reading the report.
 */
const CONST_VALUE_FLOOD = 8;

/**
 * Findings kept, most consequential first.
 *
 * A cap is necessary — a module that restructures its packages can produce
 * thousands — and where it bites, the surplus is stated rather than dropped
 * silently.
 */
const MAX_CHANGES = 200;

const PRIORITY: Record<string, number> = {
  'package-removed': 0,
  'export-removed': 1,
  'kind-changed': 2,
  'member-removed': 3,
  'member-now-required': 4,
  'signature-changed': 5,
};

export interface GoApiDiff {
  changes: SurfaceChange[];
  additions: GoAddition[];
  /** Findings beyond the cap, so the report can say the list is partial. */
  omitted: number;
}

export function diffGoApi(before: GoApi, after: GoApi): GoApiDiff {
  const changes: SurfaceChange[] = [];
  const additions: GoAddition[] = [];

  const beforePackages = new Set(before.packages);
  const afterPackages = new Set(after.packages);

  const removedPackages = before.packages.filter((pkg) => !afterPackages.has(pkg));
  for (const pkg of removedPackages) {
    changes.push({
      kind: 'package-removed',
      symbol: pkg,
      detail: `The package \`${pkg}\` no longer exists. Every import of it must move to its replacement — do not re-implement the symbols it exported.`,
    });
  }
  for (const pkg of after.packages) {
    if (!beforePackages.has(pkg)) additions.push({ kind: 'package-added', symbol: pkg });
  }

  const gone = new Set(removedPackages);
  const constValueChanges: string[] = [];

  for (const [key, old] of before.symbols) {
    // Already explained by the package that contained it.
    if (gone.has(old.pkg)) continue;

    const next = after.symbols.get(key);
    const label = display(old);

    if (!next) {
      // A method or field that disappeared alone is reported once, through the
      // type that lost it, further down.
      if (isMemberOf(old, before, after)) continue;
      changes.push({
        kind: 'export-removed',
        symbol: label,
        detail: `\`${label}\` is no longer exported (was a ${describeKind(old.kind)}).`,
        before: old.signatures[0],
      });
      continue;
    }

    if (old.kind !== next.kind) {
      changes.push({
        kind: 'kind-changed',
        symbol: label,
        detail: `\`${label}\` changed from a ${describeKind(old.kind)} to a ${describeKind(next.kind)}.`,
        before: old.signatures[0],
        after: next.signatures[0],
      });
      continue;
    }

    // Build constraints make presence a per-platform fact. A symbol that still
    // exists, but no longer on a platform this repository may build for, is a
    // removal for that platform and silence everywhere else.
    const lostPlatforms = old.platforms.filter((p) => !next.platforms.includes(p));
    if (lostPlatforms.length > 0 && next.platforms.length > 0) {
      changes.push({
        kind: 'export-removed',
        symbol: label,
        detail: `\`${label}\` is no longer available on ${lostPlatforms.join(', ')}; it remains on ${next.platforms.join(', ')}.`,
        before: old.signatures[0],
      });
    }

    for (const member of old.members) {
      if (next.members.includes(member)) continue;
      changes.push({
        kind: 'member-removed',
        symbol: `${label}.${member}`,
        detail:
          old.kind === 'interface'
            ? `The method \`${member}\` was removed from the interface \`${label}\`.`
            : `\`${label}.${member}\` was removed.`,
      });
    }

    // Adding a method to an interface breaks every implementor of it in this
    // repository, and nothing in a changelog describes that as a removal.
    if (old.kind === 'interface') {
      for (const member of next.requiredMembers) {
        if (old.requiredMembers.includes(member)) continue;
        changes.push({
          kind: 'member-now-required',
          symbol: `${label}.${member}`,
          detail: `The interface \`${label}\` now requires a \`${member}\` method. Any type in this repository that implements \`${label}\` must gain one.`,
          after: after.symbols.get(`${next.pkg}.${next.name}.${member}`)?.signatures[0],
        });
      }
    }

    const oldSig = old.signatures.join(' | ');
    const newSig = next.signatures.join(' | ');
    if (oldSig === newSig) continue;

    // A constant is the one kind whose *value* is part of its contract, and
    // also the one kind that moves in bulk.
    if (constValueOnly(old.signatures, next.signatures)) {
      constValueChanges.push(`${label}: ${oldSig} → ${newSig}`);
      continue;
    }

    changes.push({
      kind: 'signature-changed',
      symbol: label,
      detail: `The signature of \`${label}\` changed.`,
      before: oldSig,
      after: newSig,
    });
  }

  for (const [key, next] of after.symbols) {
    if (before.symbols.has(key) || !beforePackages.has(next.pkg)) continue;
    additions.push({ kind: 'export-added', symbol: display(next) });
  }

  if (constValueChanges.length > 0 && constValueChanges.length <= CONST_VALUE_FLOOD) {
    for (const entry of constValueChanges) {
      const [label, detail] = splitOnce(entry, ': ');
      changes.push({
        kind: 'signature-changed',
        symbol: label,
        detail: `The constant \`${label}\` changed value.`,
        before: splitOnce(detail, ' → ')[0],
        after: splitOnce(detail, ' → ')[1],
      });
    }
  } else if (constValueChanges.length > CONST_VALUE_FLOOD) {
    changes.push({
      kind: 'signature-changed',
      symbol: `${before.module} constants`,
      detail: `${constValueChanges.length} exported constants changed value. This is usually a regenerated platform header rather than a deliberate API change, but code that compares against a literal copy of one of these values will now disagree.`,
      after: constValueChanges.slice(0, 10).join('; '),
    });
  }

  changes.sort((a, b) => (PRIORITY[a.kind] ?? 9) - (PRIORITY[b.kind] ?? 9));
  const omitted = Math.max(0, changes.length - MAX_CHANGES);

  return { changes: changes.slice(0, MAX_CHANGES), additions, omitted };
}

/**
 * Is this symbol a method or field whose owning type still exists on both
 * sides? Then its removal is already reported as a member removal on that type.
 */
function isMemberOf(symbol: GoSymbol, before: GoApi, after: GoApi): boolean {
  const dot = symbol.name.lastIndexOf('.');
  if (dot <= 0) return false;
  const ownerKey = `${symbol.pkg}.${symbol.name.slice(0, dot)}`;
  return before.symbols.has(ownerKey) && after.symbols.has(ownerKey);
}

/** `unix.Open`, the form the symbol is actually written in Go source. */
function display(symbol: GoSymbol): string {
  return symbol.pkgName ? `${symbol.pkgName}.${symbol.name}` : symbol.name;
}

function describeKind(kind: string): string {
  switch (kind) {
    case 'class':
      return 'struct';
    case 'function':
      return 'function';
    case 'interface':
      return 'interface';
    case 'variable':
      return 'constant or variable';
    default:
      return 'type';
  }
}

/**
 * True when both sides are constant declarations of the same type and only the
 * assigned value moved.
 */
function constValueOnly(before: readonly string[], after: readonly string[]): boolean {
  if (before.length !== 1 || after.length !== 1) return false;
  const [b, a] = [before[0]!, after[0]!];
  if (!b.startsWith('const ') || !a.startsWith('const ')) return false;
  return splitOnce(b, ' = ')[0] === splitOnce(a, ' = ')[0];
}

function splitOnce(text: string, separator: string): [string, string] {
  const at = text.indexOf(separator);
  return at < 0 ? [text, ''] : [text.slice(0, at), text.slice(at + separator.length)];
}
