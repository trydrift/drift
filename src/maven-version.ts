/**
 * Maven version ordering, modelled on `org.apache.maven.artifact.versioning.ComparableVersion`.
 *
 * Maven's ordering is **separator-sensitive**: `-` opens a nested list while
 * `.` stays at the current level, so `1-1` and `1.1` are different versions and
 * `1.foo < 1-foo < 1-1 < 1.1`. A comparator that tokenises with
 * `/[0-9]+|[a-z]+/` and compares the flattened list throws that structure away
 * and silently reorders releases — which is not something that may own upgrade
 * discovery, latest selection, changelog ranges, or bump classification.
 *
 * This is a direct port of the reference algorithm rather than an
 * approximation with special cases bolted on. The item tree, the qualifier
 * table, the single-letter aliases (`a`/`b`/`m`), the canonical release
 * aliases (`ga`/`final`/`release`), and the tail normalization that makes
 * `1 == 1.0 == 1.0.0 == 1-0` are all reproduced.
 *
 * Nothing here ever reconstructs a version string: `parseMavenVersion` is a
 * comparison representation only, and the caller keeps the exact registry
 * spelling.
 */

type Item = IntItem | StringItem | ListItem;

interface IntItem {
  kind: 'int';
  value: bigint;
}

interface StringItem {
  kind: 'string';
  /** Alias-resolved qualifier: `cr` -> `rc`, `ga`/`final`/`release` -> ``. */
  value: string;
}

interface ListItem {
  kind: 'list';
  items: Item[];
}

/** Known qualifiers in ascending order. The empty string is the release itself. */
const QUALIFIERS = ['alpha', 'beta', 'milestone', 'rc', 'snapshot', '', 'sp'];

const RELEASE_INDEX = String(QUALIFIERS.indexOf(''));

const ALIASES = new Map([
  ['ga', ''],
  ['final', ''],
  ['release', ''],
  ['cr', 'rc'],
]);

/** Single letters only alias when a digit follows: `1a1` is `1-alpha-1`. */
const DIGIT_FOLLOWED_ALIASES = new Map([
  ['a', 'alpha'],
  ['b', 'beta'],
  ['m', 'milestone'],
]);

export interface MavenComparableVersion {
  items: ListItem;
}

/** Build the comparison item tree for a Maven version string. */
export function parseMavenVersion(raw: string): MavenComparableVersion {
  const version = raw.toLowerCase();
  const root: ListItem = { kind: 'list', items: [] };
  let list = root;
  const stack: ListItem[] = [root];

  let isDigit = false;
  let startIndex = 0;

  const push = (): void => {
    const next: ListItem = { kind: 'list', items: [] };
    list.items.push(next);
    list = next;
    stack.push(next);
  };

  for (let i = 0; i < version.length; i++) {
    const c = version[i]!;

    if (c === '.') {
      list.items.push(i === startIndex ? intItem(0n) : parseItem(isDigit, version.slice(startIndex, i)));
      startIndex = i + 1;
    } else if (c === '-') {
      list.items.push(i === startIndex ? intItem(0n) : parseItem(isDigit, version.slice(startIndex, i)));
      startIndex = i + 1;
      push();
    } else if (isAsciiDigit(c)) {
      if (!isDigit && i > startIndex) {
        // `1.0.0.X1 < 1.0.0-X2`: a qualifier that is followed by a digit
        // behaves as though the preceding separator had been a hyphen.
        if (list.items.length > 0) push();
        list.items.push(stringItem(version.slice(startIndex, i), true));
        startIndex = i;
        push();
      }
      isDigit = true;
    } else {
      if (isDigit && i > startIndex) {
        list.items.push(parseItem(true, version.slice(startIndex, i)));
        startIndex = i;
        push();
      }
      isDigit = false;
    }
  }

  if (version.length > startIndex) {
    list.items.push(parseItem(isDigit, version.slice(startIndex)));
  }

  while (stack.length) normalize(stack.pop()!);

  return { items: root };
}

export function compareMavenVersions(a: MavenComparableVersion, b: MavenComparableVersion): number {
  return compareItems(a.items, b.items);
}

/**
 * The leading numeric components, for bump classification.
 *
 * Tail normalization means `1.0.0` yields `[1]` and `1.0.1` yields `[1, 0, 1]`;
 * callers pad with zeroes, so the two orderings agree.
 */
export function mavenReleaseTuple(version: MavenComparableVersion): number[] | null {
  const out: number[] = [];
  let list: ListItem | null = version.items;
  while (list) {
    let next: ListItem | null = null;
    for (const item of list.items) {
      if (item.kind === 'int') {
        out.push(Number(item.value));
        continue;
      }
      if (item.kind === 'list' && out.length > 0) next = item;
      break;
    }
    list = next;
  }
  return out.length ? out : null;
}

/** True when any qualifier in the tree sorts below the release itself. */
export function mavenIsPrerelease(version: MavenComparableVersion): boolean {
  const walk = (list: ListItem): boolean =>
    list.items.some((item) => {
      if (item.kind === 'list') return walk(item);
      if (item.kind !== 'string') return false;
      return comparableQualifier(item.value) < RELEASE_INDEX;
    });
  return walk(version.items);
}

function isAsciiDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

function intItem(value: bigint): IntItem {
  return { kind: 'int', value };
}

function parseItem(isDigit: boolean, buf: string): Item {
  if (isDigit) {
    const stripped = buf.replace(/^0+/, '') || '0';
    return intItem(BigInt(stripped));
  }
  return stringItem(buf, false);
}

function stringItem(raw: string, followedByDigit: boolean): StringItem {
  let value = raw;
  if (followedByDigit && value.length === 1) {
    value = DIGIT_FOLLOWED_ALIASES.get(value) ?? value;
  }
  return { kind: 'string', value: ALIASES.get(value) ?? value };
}

/**
 * Sort key for a qualifier. Unknown qualifiers sort after every known one and
 * among themselves lexically, exactly as the reference implementation does by
 * prefixing them with the qualifier-table size.
 */
function comparableQualifier(qualifier: string): string {
  const index = QUALIFIERS.indexOf(qualifier);
  return index === -1 ? `${QUALIFIERS.length}-${qualifier}` : String(index);
}

function isNull(item: Item): boolean {
  switch (item.kind) {
    case 'int':
      return item.value === 0n;
    case 'string':
      return comparableQualifier(item.value) === RELEASE_INDEX;
    case 'list':
      return item.items.length === 0;
  }
}

/** Drop trailing null items so `1 == 1.0 == 1.0.0 == 1-0 == 1-ga`. */
function normalize(list: ListItem): void {
  for (let i = list.items.length - 1; i >= 0; i--) {
    const item = list.items[i]!;
    if (isNull(item)) list.items.splice(i, 1);
    else if (item.kind !== 'list') break;
  }
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `item` may be absent, which is how the reference implementation pads. */
function compareItems(left: Item, right: Item | null): number {
  switch (left.kind) {
    case 'int':
      return compareInt(left, right);
    case 'string':
      return compareString(left, right);
    case 'list':
      return compareList(left, right);
  }
}

function compareInt(left: IntItem, right: Item | null): number {
  if (right === null) return left.value === 0n ? 0 : 1; // 1.0 == 1, 1.1 > 1
  switch (right.kind) {
    case 'int':
      return left.value < right.value ? -1 : left.value > right.value ? 1 : 0;
    case 'string':
      return 1; // 1.1 > 1-sp
    case 'list':
      return 1; // 1.1 > 1-1
  }
}

function compareString(left: StringItem, right: Item | null): number {
  if (right === null) {
    // 1-rc < 1, 1-sp > 1
    return compareStrings(comparableQualifier(left.value), RELEASE_INDEX);
  }
  switch (right.kind) {
    case 'int':
      return -1; // 1-any < 1.1
    case 'string':
      return compareStrings(comparableQualifier(left.value), comparableQualifier(right.value));
    case 'list':
      return -1; // 1-any < 1-1
  }
}

function compareList(left: ListItem, right: Item | null): number {
  if (right === null) {
    if (left.items.length === 0) return 0; // 1-0 == 1- == 1
    return compareItems(left.items[0]!, null);
  }
  switch (right.kind) {
    case 'int':
      return -1; // 1-1 < 1.0.x
    case 'string':
      return 1; // 1-1 > 1-sp
    case 'list': {
      const length = Math.max(left.items.length, right.items.length);
      for (let i = 0; i < length; i++) {
        const l = left.items[i] ?? null;
        const r = right.items[i] ?? null;
        // When this side is shorter, invert the other side's padded compare.
        const result = l === null ? (r === null ? 0 : -compareItems(r, null)) : compareItems(l, r);
        if (result !== 0) return result;
      }
      return 0;
    }
  }
}
