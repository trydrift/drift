import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from '../dist/index/metarag.js';
import { localizeWithRuntime } from '../dist/localize/index.js';

/**
 * The two localization paths that only exist because a package's *published*
 * name is not the name in its own source: a Java type that moved package, and
 * a JavaScript module reachable only through its default export.
 *
 * Both are end-to-end — surface symbol in, file and line out — because both
 * failed as whole chains rather than in one function. The Java half is the
 * Spring 5 to 6 shape, where the break lands on the consumer's own `javax`
 * import and names nothing in `org.springframework` at all.
 */

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function sitesFor(
  files: { path: string; language: string; content: string }[],
  change: Record<string, unknown>,
  symbols: string[],
): { file: string; line: number; matchedSymbol: string }[] {
  const breaking = [
    {
      id: 'bc1',
      dependency: change.name as string,
      kind: 'removed-export',
      summary: 'moved',
      remediation: '',
      symbols,
      confidence: 'high',
      taxonomy: 'api-removal',
      citations: [],
    },
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = localizeWithRuntime(breaking as any, [change] as any, buildIndex(files as any), files as any, {
    logger: silent,
  } as any);
  return result.sites.map((site) => ({ file: site.file, line: site.line, matchedSymbol: site.matchedSymbol }));
}

const SPRING = {
  name: 'org.springframework:spring-webmvc',
  ecosystem: 'maven',
  from: '5.3.24',
  to: '6.0.5',
  kind: 'prod',
  bump: 'major',
  manifestPath: 'pom.xml',
};
const MIGRATED = ['javax.servlet.http.HttpServletRequest', 'HttpServletRequest'];

const java = (content: string) => [{ path: 'src/main/java/a/A.java', language: 'java', content }];

describe('a type that moved package', () => {
  test('lands on the import and on the use', () => {
    const sites = sitesFor(
      java(
        'package a;\n\nimport javax.servlet.http.HttpServletRequest;\n\npublic class A {\n' +
          '  public void handle(HttpServletRequest request) {\n    request.getSession();\n  }\n}\n',
      ),
      SPRING,
      MIGRATED,
    );
    assert.deepEqual(
      sites.map((site) => site.line),
      [3, 6],
    );
    assert.ok(sites.every((site) => site.matchedSymbol === 'HttpServletRequest'));
  });

  test('a consumer already on the new package is not affected', () => {
    assert.deepEqual(
      sitesFor(
        java('package a;\nimport jakarta.servlet.http.HttpServletRequest;\npublic class A { void h(HttpServletRequest r) {} }\n'),
        SPRING,
        MIGRATED,
      ),
      [],
    );
  });

  test('an unrelated `javax` package is not affected', () => {
    assert.deepEqual(
      sitesFor(
        java('package a;\nimport javax.xml.parsers.DocumentBuilderFactory;\npublic class A { void h() {} }\n'),
        SPRING,
        MIGRATED,
      ),
      [],
    );
  });

  test('the same simple name from another package is not affected', () => {
    // The one that would be easy to get wrong: `HttpServletRequest` is in this
    // file, and it belongs to somebody else.
    assert.deepEqual(
      sitesFor(
        java('package a;\nimport com.other.HttpServletRequest;\npublic class A { void h(HttpServletRequest r) {} }\n'),
        SPRING,
        MIGRATED,
      ),
      [],
    );
  });
});

const GLOB = {
  name: 'glob',
  ecosystem: 'npm',
  from: '8.1.0',
  to: '10.5.0',
  kind: 'prod',
  bump: 'major',
  manifestPath: 'package.json',
};
const ts = (content: string) => [{ path: 'src/a.ts', language: 'typescript', content }];

describe('a member of a default export', () => {
  test('binds through the name the importing file chose', () => {
    assert.deepEqual(sitesFor(ts("import glob from 'glob';\nglob.sync('x');\n"), GLOB, ['default.sync', 'sync']), [
      { file: 'src/a.ts', line: 2, matchedSymbol: 'sync' },
    ]);
  });

  test('a `require` binding is the same claim', () => {
    assert.equal(sitesFor(ts("const g = require('glob');\ng.sync('x');\n"), GLOB, ['default.sync', 'sync']).length, 1);
  });

  test('a named import binds an export, not the default', () => {
    assert.deepEqual(
      sitesFor(ts("import { globby } from 'glob';\nglobby.sync('x');\n"), GLOB, ['default.sync', 'sync']),
      [],
    );
  });

  test('another package’s default export is not this one', () => {
    assert.deepEqual(sitesFor(ts("import fs from 'fs-extra';\nfs.sync('x');\n"), GLOB, ['default.sync', 'sync']), []);
  });

  test('an unrelated receiver in an importing file is not a site', () => {
    assert.deepEqual(
      sitesFor(ts("import glob from 'glob';\nother.sync('x');\n"), GLOB, ['default.sync', 'sync']),
      [],
    );
  });
});
