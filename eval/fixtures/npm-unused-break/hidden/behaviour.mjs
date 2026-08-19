import assert from 'node:assert/strict';

// Importing the consumer's own module is the observation. A repair that
// deleted the call, emptied the file, or returned before the behaviour ran
// leaves nothing here to import, or nothing here to call.
const app = await import('../src/app.js');

assert.equal(
  typeof app.shout,
  'function',
  'src/app.js no longer exports shout(): the behaviour was removed rather than migrated.',
);

// 'grace' is deliberately an input the project's own check never uses, so a
// repair cannot satisfy this by hard-coding the one string that check compares.
assert.equal(app.shout('Ada'), 'ADA');
assert.equal(app.shout('grace'), 'GRACE');
