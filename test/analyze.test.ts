import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, matchProse } from '../dist/analyze/index.js';
import { diffSpecs } from '../dist/evidence/openapi.js';
import { diffSurfaces, extractExports } from '../dist/evidence/type-surface.js';
import { extractBreakingPassages, parseChangelogSections, sectionsBetween } from '../dist/evidence/changelog.js';
import { DEFAULT_CONFIG } from '../dist/config/schema.js';
import { createLogger } from '../dist/util/logger.js';

const logger = createLogger('error');

describe('changelog parsing', () => {
  const changelog = `# Changelog

## [3.0.0] - 2024-01-01

### Breaking Changes

- \`createClient\` has been removed. Use \`Client\` instead.
- The \`timeout\` option now requires milliseconds.

### Added
- New retry logic.

## [2.1.0] - 2023-06-01

### Added
- Streaming support.

## [2.0.0] - 2023-01-01

- \`oldMethod\` was renamed to \`newMethod\`.
`;

  test('splits into per-version sections', () => {
    const sections = parseChangelogSections(changelog);
    assert.deepEqual(
      sections.map((s) => s.version),
      ['3.0.0', '2.1.0', '2.0.0'],
    );
  });

  test('selects the exclusive-lower-bound range', () => {
    const sections = sectionsBetween(parseChangelogSections(changelog), '2.0.0', '3.0.0');
    assert.deepEqual(
      sections.map((s) => s.version),
      ['3.0.0', '2.1.0'],
      'the version you were already on describes changes you already absorbed',
    );
  });

  test('extracts breaking passages and drops additive ones', () => {
    const section = parseChangelogSections(changelog).find((s) => s.version === '3.0.0');
    const passages = extractBreakingPassages(section!.body);

    assert.ok(passages.some((p) => p.includes('createClient')));
    assert.ok(passages.some((p) => p.includes('timeout')));
    assert.ok(!passages.some((p) => p.includes('New retry logic')), 'additions are not breaking');
  });
});

describe('prose rules', () => {
  test('extracts removals', () => {
    const matches = matchProse('- `createClient` has been removed.');
    assert.equal(matches[0]?.kind, 'removed-export');
    assert.deepEqual(matches[0]?.symbols, ['createClient']);
  });

  test('extracts renames with their replacement', () => {
    const matches = matchProse('`oldMethod` was renamed to `newMethod`.');
    assert.equal(matches[0]?.kind, 'renamed-export');
    assert.deepEqual(matches[0]?.symbols, ['oldMethod']);
    assert.deepEqual(matches[0]?.replacementSymbols, ['newMethod']);
  });

  test('extracts runtime requirements', () => {
    const matches = matchProse('This release now requires Node.js >=18.');
    assert.equal(matches[0]?.kind, 'runtime-requirement');
  });

  test('requires backticks, so prose does not become a search symbol', () => {
    assert.equal(
      matchProse('We removed a lot of dead code in this release.').length,
      0,
      'unquoted English must not yield symbols',
    );
    assert.equal(matchProse('The old behaviour has been removed.').length, 0);
  });
});

describe('OpenAPI diffing', () => {
  const base = {
    openapi: '3.0.0',
    paths: {
      '/users/{id}': {
        get: {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { id: { type: 'string' }, email: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
        delete: { responses: { '204': {} } },
      },
    },
  };

  test('detects a removed operation', () => {
    const after = structuredClone(base);
    delete (after.paths['/users/{id}'] as Record<string, unknown>).delete;

    const findings = diffSpecs(JSON.stringify(base), JSON.stringify(after));
    assert.ok(findings.some((f) => f.kind === 'operation-removed' && f.location.includes('DELETE')));
  });

  test('detects a removed response field', () => {
    const after = structuredClone(base);
    delete (after.paths['/users/{id}'].get.responses['200'].content['application/json'].schema
      .properties as Record<string, unknown>).email;

    const findings = diffSpecs(JSON.stringify(base), JSON.stringify(after));
    assert.ok(findings.some((f) => f.kind === 'response-field-removed'));
  });

  test('detects a parameter becoming required', () => {
    const before = structuredClone(base);
    before.paths['/users/{id}'].get.parameters.push({
      name: 'expand',
      in: 'query',
      required: false,
      schema: { type: 'string' },
    } as never);

    const after = structuredClone(before);
    (after.paths['/users/{id}'].get.parameters[1] as { required: boolean }).required = true;

    const findings = diffSpecs(JSON.stringify(before), JSON.stringify(after));
    assert.ok(findings.some((f) => f.kind === 'parameter-now-required'));
  });

  test('reports nothing for a purely additive change', () => {
    const after = structuredClone(base);
    (after.paths['/users/{id}'].get.responses['200'].content['application/json'].schema
      .properties as Record<string, unknown>).createdAt = { type: 'string' };

    const findings = diffSpecs(JSON.stringify(base), JSON.stringify(after));
    assert.equal(findings.length, 0, 'adding a response field does not break consumers');
  });

  test('resolves local $ref', () => {
    const withRef = {
      openapi: '3.0.0',
      components: {
        schemas: { User: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } } },
      },
      paths: {
        '/me': {
          get: {
            responses: {
              '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
            },
          },
        },
      },
    };

    const after = structuredClone(withRef);
    delete (after.components.schemas.User.properties as Record<string, unknown>).name;

    const findings = diffSpecs(JSON.stringify(withRef), JSON.stringify(after));
    assert.ok(findings.some((f) => f.kind === 'response-field-removed'));
  });

  test('ignores documents that are not OpenAPI specs', () => {
    assert.equal(diffSpecs('{"a":1}', '{"a":2}').length, 0);
  });
});

describe('type surface diffing', () => {
  test('detects a removed export', () => {
    const before = extractExports('export function createClient(): void;\nexport class Client {}', 'a.d.ts');
    const after = extractExports('export class Client {}', 'a.d.ts');

    const changes = diffSurfaces(before, after);
    assert.equal(changes.length, 1);
    assert.equal(changes[0]?.kind, 'export-removed');
    assert.equal(changes[0]?.symbol, 'createClient');
  });

  test('detects a removed class member', () => {
    const before = extractExports('export class Client { request(): void; legacy(): void; }', 'a.d.ts');
    const after = extractExports('export class Client { request(): void; }', 'a.d.ts');

    const changes = diffSurfaces(before, after);
    assert.ok(changes.some((c) => c.kind === 'member-removed' && c.symbol === 'Client.legacy'));
  });

  test('detects an optional field becoming required', () => {
    const before = extractExports('export interface Options { retries?: number; }', 'a.d.ts');
    const after = extractExports('export interface Options { retries: number; }', 'a.d.ts');

    const changes = diffSurfaces(before, after);
    assert.ok(changes.some((c) => c.kind === 'member-now-required'));
  });

  test('reports nothing when the surface only grows', () => {
    const before = extractExports('export function a(): void;', 'a.d.ts');
    const after = extractExports('export function a(): void;\nexport function b(): void;', 'a.d.ts');

    assert.equal(diffSurfaces(before, after).length, 0, 'additions are not breaking');
  });

  test('parses overloads and multi-line signatures', () => {
    const api = extractExports(
      `export function fetch(url: string): Promise<Response>;
export function fetch(
  url: string,
  init: RequestInit
): Promise<Response>;`,
      'a.d.ts',
    );
    assert.equal(api.size, 1);
    assert.ok(api.get('fetch')?.signature.includes('|'), 'overloads are concatenated');
  });
});

describe('analysis', () => {
  const change = {
    name: 'acme-sdk',
    ecosystem: 'npm' as const,
    from: '1.0.0',
    to: '2.0.0',
    kind: 'runtime' as const,
    bump: 'major' as const,
    manifestPath: 'package.json',
  };

  test('computed findings become high-confidence changes', async () => {
    const evidence = [
      {
        id: 'ev_1',
        source: 'type-surface-diff' as const,
        dependency: 'acme-sdk',
        title: 'surface diff',
        content: '- [export-removed] `createClient` is no longer exported.',
        weight: 1,
        findings: [
          { code: 'export-removed', symbol: 'createClient', detail: '`createClient` was removed.' },
        ],
      },
    ];

    const result = await analyze([change], evidence, { config: DEFAULT_CONFIG, logger });
    assert.equal(result.length, 1);
    assert.equal(result[0]?.confidence, 'high');
    assert.deepEqual(result[0]?.citations, ['ev_1']);
    assert.ok(result[0]?.symbols.includes('createClient'));
  });

  test('every breaking change carries at least one citation', async () => {
    const evidence = [
      {
        id: 'ev_changelog',
        source: 'changelog' as const,
        dependency: 'acme-sdk',
        title: 'CHANGELOG',
        content: '- `legacyCall` has been removed.',
        weight: 0.65,
      },
    ];

    const result = await analyze([change], evidence, { config: DEFAULT_CONFIG, logger });
    assert.ok(result.length > 0);
    for (const finding of result) {
      assert.ok(finding.citations.length > 0, 'the citation invariant must hold for every finding');
    }
  });

  test('corroboration across two sources raises confidence to high', async () => {
    const evidence = [
      {
        id: 'ev_changelog',
        source: 'changelog' as const,
        dependency: 'acme-sdk',
        title: 'CHANGELOG',
        content: '- `createClient` has been removed.',
        weight: 0.65,
      },
      {
        id: 'ev_surface',
        source: 'type-surface-diff' as const,
        dependency: 'acme-sdk',
        title: 'surface diff',
        content: 'removed',
        weight: 1,
        findings: [
          { code: 'export-removed', symbol: 'createClient', detail: '`createClient` was removed.' },
        ],
      },
    ];

    const result = await analyze([change], evidence, { config: DEFAULT_CONFIG, logger });
    const finding = result.find((r) => r.symbols.includes('createClient'));

    assert.equal(finding?.confidence, 'high');
    assert.ok(finding!.citations.length >= 2, 'both sources are cited on the merged finding');
  });

  test('semver-only evidence yields no breaking change', async () => {
    const evidence = [
      {
        id: 'ev_semver',
        source: 'semver-heuristic' as const,
        dependency: 'acme-sdk',
        title: 'major bump',
        content: 'Major version bump 1.0.0 -> 2.0.0.',
        weight: 0.25,
      },
    ];

    const result = await analyze([change], evidence, { config: DEFAULT_CONFIG, logger });
    assert.equal(result.length, 0, 'a version number alone is not a breaking change');
  });
});
