/**
 * Validation still has to reject what it rejected before.
 *
 * ajv 8 exports its class as a default export, so `import * as JsonValidator`
 * plus `new JsonValidator()` stops compiling. That is one line, and the
 * shortest way to a green build is to stop constructing a validator at all —
 * return `true`, drop the dependency, widen the type. Every one of those
 * compiles, and every one turns the toggle schema into decoration: the service
 * would then accept a remote toggle map with a fraction of 7 or no type at all
 * and write it straight into its toggle store.
 *
 * So this exercises the compiled `objectMatchesSchema` against the project's
 * own schema, in both directions.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { objectMatchesSchema } = require('../dist/main/utils.js');
const { toggleSchema } = require('../dist/main/schema.js');

assert.equal(typeof objectMatchesSchema, 'function', 'dist/main/utils.js must still export objectMatchesSchema');
assert.ok(toggleSchema && typeof toggleSchema === 'object', 'dist/main/schema.js must still export toggleSchema');

assert.equal(
  objectMatchesSchema(toggleSchema, { 'my-toggle': { type: 'fraction', fraction: 0.5 } }),
  true,
  'a toggle map that satisfies the schema must be accepted',
);
assert.equal(
  objectMatchesSchema(toggleSchema, { 'other toggle': { type: 'boolean', fraction: 0 } }),
  true,
  'the boundary value fraction=0 is within [0,1] and must be accepted',
);

assert.equal(
  objectMatchesSchema(toggleSchema, { 'my-toggle': { type: 'fraction', fraction: 7 } }),
  false,
  'a fraction above the schema maximum of 1 must be rejected — a validator that answers true here is not validating',
);
assert.equal(
  objectMatchesSchema(toggleSchema, { 'my-toggle': { fraction: 0.5 } }),
  false,
  'a toggle missing the required `type` must be rejected',
);
assert.equal(
  objectMatchesSchema(toggleSchema, { 'my-toggle': { type: 'fraction', fraction: 'half' } }),
  false,
  'a non-numeric fraction must be rejected',
);

console.log('validation-behaviour: the toggle schema still accepts valid maps and rejects invalid ones');
