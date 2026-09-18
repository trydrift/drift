/**
 * The cache has to still store entries.
 *
 * lru-cache 10 drops the default export, so the project stops compiling and
 * the removed import is the visible half of this upgrade. The invisible half
 * is `maxSize`: in v7 it bounded the cache on its own, in v10 it is the
 * size-based bound and throws on every `set` unless `sizeCalculation` or a
 * per-entry `size` comes with it. A migration that only repairs the import
 * compiles and constructs, and then throws inside `BaseDNS.lookup` at the
 * `this.cache.set(...)` line — where the method's own try/catch swallows it
 * and returns the hostname unresolved, before `_lookup` is ever called. Build
 * green, types right, and not one name resolved.
 *
 * This exercises the compiled class rather than reading its source, and asserts
 * on how often the underlying lookup runs rather than on what `lookup` returns:
 * the repository has a pre-existing bug on its cache-*hit* path (`DynamicChoice`
 * has no `doCount` method, so a hit throws and returns the hostname) which has
 * nothing to do with this upgrade and must not be something the agent is asked
 * to fix.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BaseDNS = require('../dist/dns/base.js').default;

assert.equal(typeof BaseDNS, 'function', 'dist/dns/base.js should still default-export the BaseDNS class');

let lookups = 0;
class StubDNS extends BaseDNS {
  _lookup(hostName) {
    lookups += 1;
    return Promise.resolve(['93.184.216.34', `alt-${hostName}`]);
  }
}

const dns = new StubDNS('1.1.1.1');

const first = await dns.lookup('example.com');
assert.equal(
  lookups,
  1,
  'the first resolution must reach the underlying lookup. Reaching it zero times means `this.cache.set(...)` threw first — ' +
    'lru-cache 10 rejects every `set` when `maxSize` is configured without `sizeCalculation` — and `lookup`\'s try/catch hid it',
);
assert.equal(
  first,
  '93.184.216.34',
  'the first resolution must return the resolved address, not the hostname it was given (the hostname is what the swallowed cache error returns)',
);

await dns.lookup('example.com');
assert.equal(
  lookups,
  1,
  'the second resolution of the same host must be served from the cache, not resolved again — if the entry was never stored, `set` is throwing',
);

// A cache that stored one entry and nothing else would also pass the check
// above, so resolve a second host: it must reach the lookup once, and once only.
await dns.lookup('example.org');
assert.equal(lookups, 2, 'a different host must reach the underlying lookup');
await dns.lookup('example.org');
assert.equal(lookups, 2, 'the second host must be cached too');

console.log('cache-behaviour: lru-cache stores and serves entries through BaseDNS');
