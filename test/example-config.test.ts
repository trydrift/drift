import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseConfig } from '../dist/config/load.js';
import {
  DEFAULT_CONFIG,
  opensPullRequestAsDraft,
  usesDeprecatedDraftSetting,
} from '../dist/config/schema.js';

/**
 * `examples/drift.yml` says, at the top, that every value in it is the default.
 *
 * It was not. It set `ecosystems: [npm, pypi, go, cargo, maven, rubygems]`,
 * so copying Drift's own recommended configuration silently switched off ten
 * ecosystems — NuGet, Packagist, Hex, pub, Swift, CocoaPods, opam, Conan,
 * vcpkg and Arduino. Following the setup instructions made the product
 * strictly worse than not configuring it at all, and nothing said so.
 *
 * The claim is now checked rather than made. Every key the example sets must
 * parse to exactly what `DEFAULT_CONFIG` has, so the file cannot promise
 * "these are the defaults" and quietly mean something else.
 */

const EXAMPLE = 'examples/drift.yml';

async function parseExample() {
  const raw = await readFile(EXAMPLE, 'utf8');
  const result = parseConfig(raw, EXAMPLE);
  assert.deepEqual(result.problems, [], 'the example config must parse without problems');
  return result.config;
}

describe('examples/drift.yml', () => {
  test('parses cleanly against the schema', async () => {
    await parseExample();
  });

  test('every value it sets really is the default', async () => {
    const config = await parseExample();

    // Deep equality against DEFAULT_CONFIG is the whole check: because the
    // schema fills in every omitted key with its default, a parsed example
    // that sets only defaults is indistinguishable from an empty document.
    // Any difference means the file overrides something while claiming not to.
    assert.deepEqual(
      config,
      DEFAULT_CONFIG,
      'examples/drift.yml claims every value is the default — one of them is not',
    );
  });

  test('it enables every ecosystem, not a subset', async () => {
    const config = await parseExample();
    assert.equal(
      config.ecosystems.length,
      DEFAULT_CONFIG.ecosystems.length,
      'the recommended config must not silently narrow ecosystem coverage',
    );
  });

  test('the ecosystem names it uses are the schema’s, not the tools’', async () => {
    const raw = await readFile(EXAMPLE, 'utf8');
    // `composer` is the tool; `packagist` is the registry and the identifier.
    // A config using the wrong one fails to parse and falls back to defaults,
    // which looks like it worked.
    const config = await parseExample();
    assert.ok(config.ecosystems.includes('packagist'));
    assert.ok(!raw.includes('\n    composer,'), 'use `packagist`, not `composer`');
  });
});

describe('documented ecosystem identifiers', () => {
  test('docs/configuration.md lists every ecosystem the schema accepts', async () => {
    const docs = await readFile('docs/configuration.md', 'utf8');
    for (const ecosystem of DEFAULT_CONFIG.ecosystems) {
      assert.ok(
        docs.includes(`\`${ecosystem}\``),
        `docs/configuration.md never mentions the \`${ecosystem}\` ecosystem`,
      );
    }
  });
});

/**
 * Two spellings of one setting.
 *
 * `pullRequest.draft` and the deprecated `remediation.draftPr` were both read,
 * OR'd together at each call site. `draftPr` defaulted to `true` and the
 * shipped example set it to `true`, so `pullRequest.draft: false` — the field
 * the documentation points at — changed nothing at all.
 */
describe('pull request draft precedence', () => {
  const resolve = (yaml: string) => {
    const { config, problems } = parseConfig(yaml, 'test.yml');
    assert.deepEqual(problems, []);
    return opensPullRequestAsDraft(config);
  };

  test('the default is a draft, which is what Drift has always done', () => {
    assert.equal(resolve('mode: approve\n'), true);
  });

  test('the current field turns drafts off on its own', () => {
    // The bug: this returned `true`, because the legacy default won.
    assert.equal(resolve('pullRequest:\n  draft: false\n'), false);
  });

  test('the current field wins over the deprecated one, in both directions', () => {
    assert.equal(resolve('pullRequest:\n  draft: false\nremediation:\n  draftPr: true\n'), false);
    assert.equal(resolve('pullRequest:\n  draft: true\nremediation:\n  draftPr: false\n'), true);
  });

  test('an existing config using only the deprecated field still works', () => {
    assert.equal(resolve('remediation:\n  draftPr: false\n'), false);
    assert.equal(resolve('remediation:\n  draftPr: true\n'), true);
  });

  test('the deprecated field is detectable, so a caller can warn about it', () => {
    const { config } = parseConfig('remediation:\n  draftPr: true\n', 'test.yml');
    assert.equal(usesDeprecatedDraftSetting(config), true);
    assert.equal(usesDeprecatedDraftSetting(DEFAULT_CONFIG), false);
  });
});
