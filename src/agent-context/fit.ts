import { byteLength } from './budget.js';

/**
 * Filling a JSON object up to a byte ceiling, whole items at a time.
 *
 * Every structured agent surface is built the same way: an irreducible core
 * goes in first, then each variable-size section in a fixed priority order,
 * item by item, measuring the serialized object after every addition. An item
 * that would cross the ceiling is not added, and neither is anything after it
 * in that section, so a section is always a prefix of its ordered items and
 * the count of what was left out is exact. A later, lower-priority section may
 * still place smaller items.
 *
 * If the core alone does not fit, the surface throws rather than returning
 * something larger than its contract allows.
 */

export class AgentBudgetExceededError extends Error {
  constructor(
    readonly surface: string,
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(`The ${surface} cannot be represented within ${limit} bytes: its irreducible core is ${bytes} bytes.`);
    this.name = 'AgentBudgetExceededError';
  }
}

export function jsonBytes(value: unknown): number {
  return byteLength(JSON.stringify(value));
}

/** Throw unless `root` already fits. Call once the core is in place. */
export function requireCoreFits(surface: string, root: unknown, limit: number): void {
  const bytes = jsonBytes(root);
  if (bytes > limit) throw new AgentBudgetExceededError(surface, bytes, limit);
}

/**
 * Append items to `target` in order while `root` stays within `limit`.
 *
 * `account(added)` is called after each attempt with the number placed so
 * far, so "not shown" counters in `root` are exact at every measurement — a
 * counter shrinking from 3 digits to 1 is part of what is measured. Returns
 * the number of items placed.
 *
 * Callers must initialise every counter in `root` to its full total before the
 * core is measured. Counters then only shrink as items are placed, so an
 * unmeasured `account(0)` can never make the object larger than it was.
 */
export function fillWhole<T>(
  root: unknown,
  target: T[],
  items: readonly T[],
  limit: number,
  account: (added: number) => void = () => undefined,
): number {
  let added = 0;
  account(0);
  for (const item of items) {
    target.push(item);
    account(added + 1);
    if (jsonBytes(root) > limit) {
      target.pop();
      account(added);
      break;
    }
    added += 1;
  }
  return added;
}

/**
 * Set an optional field only if the object still fits with it. Returns whether it was set.
 */
export function setIfFits<T extends object, K extends keyof T>(root: unknown, target: T, key: K, value: T[K], limit: number): boolean {
  const had = Object.prototype.hasOwnProperty.call(target, key);
  const previous = target[key];
  target[key] = value;
  if (jsonBytes(root) <= limit) return true;
  if (had) target[key] = previous;
  else delete target[key];
  return false;
}

/**
 * The longest prefix of `content` that, assigned through `assign`, keeps
 * `root` within `limit` — ending at a line break when the prefix contains one,
 * so a page does not stop mid-line unless a single line is longer than a page.
 * Binary search over character counts, so the result is deterministic.
 */
export function fitPrefix(root: unknown, content: string, limit: number, assign: (text: string) => void): string {
  assign('');
  if (jsonBytes(root) > limit) return '';
  let low = 0;
  let high = content.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    assign(content.slice(0, mid));
    if (jsonBytes(root) <= limit) low = mid;
    else high = mid - 1;
  }
  let prefix = content.slice(0, low);
  if (low < content.length) {
    const lastBreak = prefix.lastIndexOf('\n');
    if (lastBreak > 0) prefix = prefix.slice(0, lastBreak + 1);
    // Never end on half of a surrogate pair.
    if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
  }
  assign(prefix);
  return prefix;
}
