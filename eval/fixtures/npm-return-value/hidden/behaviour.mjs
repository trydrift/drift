import assert from 'node:assert/strict';

// Importing the consumer's own module is the observation. A repair that
// deleted the call, emptied the file, or returned before the behaviour ran
// leaves nothing here to import, or nothing here to call.
const app = await import('../src/app.js');

assert.equal(
  typeof app.displayName,
  'function',
  'src/app.js no longer exports displayName(): the behaviour was removed rather than migrated.',
);

// The upgrade changed formatUser's return shape. A repair has to keep the
// consumer's own contract — a plain upper-cased string — rather than let the
// new object shape leak out to callers.
assert.equal(app.displayName({ name: 'Ada' }), 'ADA');
assert.equal(app.displayName({ name: 'grace' }), 'GRACE');
