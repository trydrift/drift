/**
 * Runtime requirement prose parsing — the recall surface.
 *
 * A false negative here is silent: if release-note wording never becomes a
 * structured `RuntimeRequirement`, `RuntimeRequirementAnalysis` never runs and
 * Drift treats the upgrade as having no runtime compatibility question at all.
 * These tests therefore pin the *structured output* of every syntax family the
 * grammar is meant to accept, plus a negative table proving unrelated version
 * prose is not swept in.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { matchProse } from '../dist/analyze/index.js';

const runtimeOf = (text: string) =>
  matchProse(text).find((match) => match.kind === 'runtime-requirement')?.runtime;

interface PositiveCase {
  text: string;
  kind: 'minimum-runtime' | 'unsupported-runtime-range';
  runtime: string;
  requirement: string;
  derivedMinimum?: string;
  rangeParseStatus?: 'unknown';
}

const POSITIVE: PositiveCase[] = [
  // Dropped-support wording keeps the unsupported range faithfully; a floor is
  // only derived where the complement is mathematically exact (`<` / `<=`).
  { text: 'Dropped support for Python versions <3.9', kind: 'unsupported-runtime-range', runtime: 'python', requirement: '<3.9', derivedMinimum: '>=3.9' },
  { text: 'Dropped support for Python version <3.9', kind: 'unsupported-runtime-range', runtime: 'python', requirement: '<3.9', derivedMinimum: '>=3.9' },
  { text: 'Dropped support for Node.js v18', kind: 'unsupported-runtime-range', runtime: 'node', requirement: '18.x' },
  { text: 'Dropped support for Node.js v18.', kind: 'unsupported-runtime-range', runtime: 'node', requirement: '18.x' },
  { text: 'Node 16 is no longer supported', kind: 'unsupported-runtime-range', runtime: 'node', requirement: '16.x' },
  { text: 'Python versions <3.9 are no longer supported', kind: 'unsupported-runtime-range', runtime: 'python', requirement: '<3.9', derivedMinimum: '>=3.9' },
  { text: 'Support for Ruby 2.7 was removed', kind: 'unsupported-runtime-range', runtime: 'ruby', requirement: '2.7.x' },
  { text: 'Node.js v18 is no longer supported', kind: 'unsupported-runtime-range', runtime: 'node', requirement: '18.x' },

  // Minimum-runtime wording, across the "requires / required / now required /
  // minimum" verbs and the optional `v`, `version`, `is`, and `:` separators.
  { text: 'Requires Node v20', kind: 'minimum-runtime', runtime: 'node', requirement: '>=20' },
  { text: 'Requires Node.js version 20', kind: 'minimum-runtime', runtime: 'node', requirement: '>=20' },
  { text: 'Required Node.js >=14.16', kind: 'minimum-runtime', runtime: 'node', requirement: '>=14.16' },
  { text: 'Node v20 is now required', kind: 'minimum-runtime', runtime: 'node', requirement: '>=20' },
  { text: 'Minimum supported Python version is 3.10', kind: 'minimum-runtime', runtime: 'python', requirement: '>=3.10' },
  { text: 'Minimum Python version is 3.10', kind: 'minimum-runtime', runtime: 'python', requirement: '>=3.10' },
  { text: 'Minimum Python version: 3.10', kind: 'minimum-runtime', runtime: 'python', requirement: '>=3.10' },
  { text: 'Minimum Java version raised to 21', kind: 'minimum-runtime', runtime: 'java', requirement: '>=21' },
  { text: 'Rust MSRV is now 1.80', kind: 'minimum-runtime', runtime: 'rust', requirement: '>=1.80' },
  { text: 'This release now requires Go 1.21', kind: 'minimum-runtime', runtime: 'go', requirement: '>=1.21' },

  // A `||` disjunction (semver's OR operator) is kept whole, branch for
  // branch, not truncated at the first alternative — this is Jest 30's own
  // `engines.node`, the exact text that misclassified GitLab's `.nvmrc`.
  {
    text: 'Requires Node.js ^18.14.0 || ^20.0.0 || ^22.0.0 || >=24.0.0',
    kind: 'minimum-runtime',
    runtime: 'node',
    requirement: '^18.14.0 || ^20.0.0 || ^22.0.0 || >=24.0.0',
  },

  // Grammar the ecosystem does not define is carried through intact and flagged
  // `unknown`; npm semver semantics are never silently applied to Ruby/Python.
  { text: 'Requires Ruby ~>3.0', kind: 'minimum-runtime', runtime: 'ruby', requirement: '~>3.0', rangeParseStatus: 'unknown' },
  { text: 'Dropped support for Python ^3.10', kind: 'unsupported-runtime-range', runtime: 'python', requirement: '^3.10', rangeParseStatus: 'unknown' },
  // `||` has no meaning in RubyGems' grammar: the full requirement is still
  // preserved, but its state stays `unknown` rather than being guessed.
  { text: 'Requires Ruby 3.1 || 3.2', kind: 'minimum-runtime', runtime: 'ruby', requirement: '>=3.1 || >=3.2', rangeParseStatus: 'unknown' },
];

describe('runtime prose: positive syntax families produce faithful structured requirements', () => {
  for (const c of POSITIVE) {
    test(c.text, () => {
      const runtime = runtimeOf(c.text);
      assert.ok(runtime, `"${c.text}" produced no structured runtime requirement`);
      assert.equal(runtime!.kind, c.kind, 'kind');
      assert.equal(runtime!.runtime, c.runtime, 'runtime identity');
      assert.equal(runtime!.requirement, c.requirement, 'requirement');
      const derived = runtime && 'derivedMinimum' in runtime ? runtime.derivedMinimum : undefined;
      assert.equal(derived, c.derivedMinimum, 'derivedMinimum');
      assert.equal(runtime!.rangeParseStatus, c.rangeParseStatus, 'rangeParseStatus');
    });
  }

  test('a dropped range with no exact complement carries no fabricated floor', () => {
    for (const text of ['Dropped support for Node.js v18', 'Node 16 is no longer supported', 'Support for Ruby 2.7 was removed']) {
      const runtime = runtimeOf(text)!;
      assert.equal('derivedMinimum' in runtime ? runtime.derivedMinimum : undefined, undefined, text);
    }
  });

  test('every positive case also reaches matchProse as a runtime-requirement kind', () => {
    for (const c of POSITIVE) {
      assert.ok(
        matchProse(c.text).some((m) => m.kind === 'runtime-requirement' && m.runtime),
        `"${c.text}" did not reach the structured runtime path`,
      );
    }
  });
});

const NEGATIVE: string[] = [
  // Library / package versions.
  'Requires lodash >=4.0',
  'Dropped support for Mongoid < 8',
  'Minimum webpack version is 5',
  'Support for React 17 was removed',
  // API / protocol / schema versions.
  'API version 2 is no longer supported',
  'Minimum protocol version is 3',
  'Dropped support for schema version 1',
  // Runtime name present, but no compatibility constraint is being stated.
  'Rewrote the Node.js bindings for speed',
  'Bumped the Go client to v2',
  'The Python examples were updated to 3.12 syntax',
  'Go 1.x modules are now the default',
  // No runtime name at all.
  'Dropped support for the legacy authentication flow',
  'Requires at least 2GB of RAM',
  'Minimum Node version raised to .',
  // Substring traps: "go" in "google", "java" in "javascript".
  'Requires google-cloud-storage >=2.0',
  'Requires JavaScript modules 2020',
];

describe('runtime prose: unrelated version wording never becomes a runtime requirement', () => {
  for (const text of NEGATIVE) {
    test(text, () => {
      assert.equal(
        matchProse(text).some((match) => match.kind === 'runtime-requirement'),
        false,
        `"${text}" was misclassified as a runtime requirement`,
      );
    });
  }
});
