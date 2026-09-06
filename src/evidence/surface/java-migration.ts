/**
 * Package migrations, read off a japicmp report.
 *
 * The `javax` to `jakarta` move — Spring 6, Jersey 3, Hibernate 6, and every
 * library that followed Jakarta EE 9 — breaks a consumer at *its own* import of
 * the moved type, not at any symbol the changed library owns. japicmp reports
 * it as a removed method beside an added one whose signatures differ only by a
 * package prefix:
 *
 *     ---! REMOVED METHOD: PUBLIC void preHandle(javax.servlet.http.HttpServletRequest, …)
 *     +++  NEW METHOD:     PUBLIC void preHandle(jakarta.servlet.http.HttpServletRequest, …)
 *
 * Pairing those recovers the fact a consumer needs: `javax.servlet.http` is
 * gone from this library's API. Without it Drift searches for the *owning*
 * class (`HandlerInterceptor`), which a Spring application typically never
 * names, and finds nothing while the build fails on ten `javax` imports.
 */

/**
 * A member signature japicmp printed, reduced to what a migration check needs.
 *
 * japicmp prints a member as `MODIFIERS returnType name(paramType, …)`. Only
 * the erased types matter here: `List<String>` and `List<Integer>` are the same
 * type to a classfile, and a package migration is visible in the erasure.
 */
export interface MemberSignature {
  owner: string;
  name: string;
  params: string[];
  /** `null` for a constructor, which declares no return type. */
  returns: string | null;
  /** Whether japicmp flagged the line this came from binary-incompatible. */
  binaryBreaking: boolean;
}

/** One type that moved package, keeping its simple name. */
export interface MigratedType {
  from: string;
  to: string;
}

/** A package that moved wholesale, and the types seen moving with it. */
export interface PackageMigration {
  fromPackage: string;
  toPackage: string;
  types: MigratedType[];
}

/**
 * How many distinct member signatures must witness a package pair before it is
 * called a migration.
 *
 * One matched pair is already decent evidence — a method keeping its name and
 * arity while a parameter's package changes under an identical simple name is
 * not a coincidence. Two is required anyway because the cost of the two errors
 * is not symmetric: a missed migration loses recall on one library, while a
 * spurious one names an import that consumers really do have (`java.util` is in
 * every file) and would report a whole repository as affected. Every real
 * migration this is aimed at is witnessed by hundreds.
 */
const MIGRATION_MIN_WITNESSES = 2;

/**
 * Ceiling on migrated types reported per diff.
 *
 * Each one is a genuine localization anchor, so this is not a relevance filter
 * but a bound on report size for a diff like Spring 5 to 6 that moves an entire
 * namespace at once.
 */
const MAX_MIGRATED_TYPES = 64;

/** `java.util.List<String>[]` becomes `java.util.List`. */
function erase(type: string): string {
  let depth = 0;
  let out = '';
  for (const char of type) {
    if (char === '<') depth++;
    else if (char === '>') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += char;
  }
  return out.replace(/\[\]/g, '').trim();
}

/** Split a parameter list on the commas that are not inside generic arguments. */
export function splitParameters(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '<') depth++;
    else if (char === '>') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => erase(part)).filter((part) => part.length > 0);
}

/**
 * Read one japicmp member line into a {@link MemberSignature}.
 *
 * Returns `null` for anything without a parameter list — a field, or a line
 * whose shape this does not recognise — since a migration is only observable by
 * lining two parameter lists up against each other.
 */
export function parseMemberSignature(
  rest: string,
  owner: string,
  binaryBreaking: boolean,
): MemberSignature | null {
  const cleaned = rest
    .replace(/\s*\(<-\s*[^)]+\)/g, '')
    .replace(/\([+-]\)/g, '')
    .trim();

  const open = cleaned.indexOf('(');
  const close = cleaned.lastIndexOf(')');
  if (open === -1 || close < open) return null;

  const head = cleaned.slice(0, open).trim().split(/\s+/);
  const name = head[head.length - 1];
  if (!name || !/^[\w.$]+$/.test(name)) return null;

  // The token before the name is the return type, when there is one. A
  // constructor has only modifiers in front of it, and japicmp's modifiers are
  // uppercase words with no dots — never a type worth comparing.
  const previous = head[head.length - 2];
  const returns = previous && /[.a-z]/.test(previous) ? erase(previous) : null;

  return {
    owner,
    name,
    params: splitParameters(cleaned.slice(open + 1, close)),
    returns,
    binaryBreaking,
  };
}

/** `javax.servlet.http.HttpServletRequest` becomes `javax.servlet.http`. */
function packageOf(type: string): string | null {
  const cut = type.lastIndexOf('.');
  return cut > 0 ? type.slice(0, cut) : null;
}

/** `javax.servlet.http.HttpServletRequest` becomes `HttpServletRequest`. */
function simpleNameOf(type: string): string {
  return type.slice(type.lastIndexOf('.') + 1);
}

/**
 * Types that moved package between the two versions, from matched
 * removed/added member pairs.
 *
 * Matching is deliberately strict — same owner, same member name, same arity,
 * and a type whose simple name is unchanged while its package is not — so a
 * genuine type *replacement* (a different type, differently named) is never
 * read as a migration.
 */
export function detectPackageMigrations(
  removed: readonly MemberSignature[],
  added: readonly MemberSignature[],
): PackageMigration[] {
  const key = (member: MemberSignature): string =>
    `${member.owner} ${member.name} ${member.params.length}`;

  const addedByKey = new Map<string, MemberSignature[]>();
  for (const member of added) {
    const existing = addedByKey.get(key(member));
    if (existing) existing.push(member);
    else addedByKey.set(key(member), [member]);
  }

  // Package pair to the evidence for it. `witnesses` counts distinct member
  // signatures rather than type occurrences: one method taking four `javax`
  // parameters is one observation of the migration, not four.
  const pairs = new Map<
    string,
    { types: Map<string, string>; witnesses: Set<string>; binaryBreaking: boolean }
  >();

  for (const before of removed) {
    for (const after of addedByKey.get(key(before)) ?? []) {
      const beforeTypes = [...before.params, ...(before.returns === null ? [] : [before.returns])];
      const afterTypes = [...after.params, ...(after.returns === null ? [] : [after.returns])];
      if (beforeTypes.length !== afterTypes.length) continue;

      for (const [index, oldType] of beforeTypes.entries()) {
        const newType = afterTypes[index]!;
        if (oldType === newType) continue;
        if (simpleNameOf(oldType) !== simpleNameOf(newType)) continue;

        const oldPackage = packageOf(oldType);
        const newPackage = packageOf(newType);
        if (!oldPackage || !newPackage || oldPackage === newPackage) continue;

        const pairKey = `${oldPackage} ${newPackage}`;
        let entry = pairs.get(pairKey);
        if (!entry) {
          entry = { types: new Map(), witnesses: new Set(), binaryBreaking: false };
          pairs.set(pairKey, entry);
        }
        entry.types.set(oldType, newType);
        entry.witnesses.add(`${before.owner}.${before.name}/${before.params.length}`);
        // A migration is only reported when japicmp itself called at least one
        // of the removals binary-incompatible, keeping this inside the same
        // `!`-only discipline as every other change the parser emits.
        if (before.binaryBreaking) entry.binaryBreaking = true;
      }
    }
  }

  const migrations: PackageMigration[] = [];
  for (const [pairKey, entry] of pairs) {
    if (!entry.binaryBreaking) continue;
    if (entry.witnesses.size < MIGRATION_MIN_WITNESSES) continue;
    const [fromPackage, toPackage] = pairKey.split(' ') as [string, string];
    migrations.push({
      fromPackage,
      toPackage,
      types: [...entry.types].map(([from, to]) => ({ from, to })),
    });
  }

  // Largest migrations first, so truncation drops the marginal ones.
  migrations.sort(
    (a, b) => b.types.length - a.types.length || a.fromPackage.localeCompare(b.fromPackage),
  );

  let budget = MAX_MIGRATED_TYPES;
  const bounded: PackageMigration[] = [];
  for (const migration of migrations) {
    if (budget <= 0) break;
    bounded.push({ ...migration, types: migration.types.slice(0, budget) });
    budget -= Math.min(budget, migration.types.length);
  }
  return bounded;
}
