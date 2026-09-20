/**
 * The include/exclude selectors still have to reach axe.
 *
 * axe-core 4 turned the analysis context into a union — a bare selector, or an
 * object carrying at least one of `include`/`exclude` — so `const ctx:
 * Axe.ElementContext = {}` followed by assignments no longer typechecks. Three
 * compile errors, and several ways to silence them that are not migrations:
 * typing the object `any`, casting it, or dropping one of the two branches.
 * Each one compiles. Each one changes which part of the page is scanned, and
 * an accessibility scan that silently widens to the whole document (or narrows
 * to nothing) reports the wrong violations without ever failing.
 *
 * So this drives the compiled AxePuppeteer against a stub frame and asserts on
 * the context it hands to `frame.evaluate` — the value `normalizeContext`
 * produced — for every combination of include and exclude.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AxePuppeteer } = require('../dist/index.js');

assert.equal(typeof AxePuppeteer, 'function', 'dist/index.js must still export the AxePuppeteer class');

const AXE_RESULTS = { violations: [], passes: [], incomplete: [], inapplicable: [] };

/**
 * The smallest frame AxePuppeteer will talk to: `analyze` waits for `html`,
 * asks whether the page is loaded, injects axe, and then evaluates the run.
 * Every `evaluate` call is recorded so the run's own arguments can be read back.
 */
function stubFrame() {
  const calls = [];
  return {
    calls,
    waitForSelector: async () => ({}),
    addScriptTag: async () => ({}),
    evaluate: async (fn, ...args) => {
      calls.push(args);
      // `pageIsLoaded` is evaluated with no arguments and must answer true;
      // every other evaluation here is the axe run itself.
      if (args.length === 0) return true;
      return AXE_RESULTS;
    },
    childFrames: () => [],
    $: async () => ({}),
    url: () => 'http://localhost/',
  };
}

/** The context argument of the axe run: `evaluate(runAxe, config, context, options)`. */
async function contextFor(configure) {
  const frame = stubFrame();
  const axe = new AxePuppeteer(frame, 'window.axe = {};');
  configure(axe);
  await axe.analyze();
  const run = frame.calls.find((args) => args.length >= 3);
  assert.ok(run, 'AxePuppeteer must evaluate the axe run in the frame');
  return run[1];
}

assert.deepEqual(
  await contextFor((axe) => axe.include('#main').exclude('.ad')),
  { include: [['#main']], exclude: [['.ad']] },
  'with both an include and an exclude, both must reach axe',
);

// `exclude: []` alongside the include is accepted: an empty exclusion list
// excludes nothing, so it scans exactly what naming only `include` scans. The
// risk this case is about is a scan that silently widens or narrows, and that
// shape does neither — asserting the object's exact keys would fail a
// migration that is behaviourally identical.
const includeOnly = await contextFor((axe) => axe.include('#main'));
assert.deepEqual(includeOnly.include, [['#main']], 'an include on its own must reach axe');
assert.deepEqual(
  includeOnly.exclude ?? [],
  [],
  'nothing may be excluded when the caller excluded nothing',
);

const excludeOnly = await contextFor((axe) => axe.exclude('.ad'));
assert.deepEqual(
  excludeOnly.exclude,
  [['.ad']],
  'an exclude on its own must reach axe — dropping it scans the whole document, which is not what the caller asked for',
);
assert.deepEqual(excludeOnly.include ?? [], [], 'nothing may be force-included when the caller included nothing');

assert.equal(
  await contextFor(() => {}),
  null,
  'with neither, the context must stay null so axe scans the document by default',
);

console.log('context-behaviour: include and exclude selectors still reach the axe run');
