import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, declaresBreakingChange, matchProse } from '../dist/analyze/index.js';
import { diffSpecs } from '../dist/evidence/spec/openapi.js';
import {
  acceptsCallOfArity,
  callCannotResolveTo,
  diffSurfaces,
  extractExports,
} from '../dist/evidence/type-surface.js';
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

  test('catches an ESM-only migration, which renames no export', () => {
    const matches = matchProse('## This package is now pure ESM');
    assert.equal(matches[0]?.kind, 'module-system-change');
    assert.deepEqual(matches[0]?.symbols, [], 'a package-wide change names no symbol');
    assert.deepEqual(matches[0]?.moduleSystem?.incompatibleUsage, ['require']);
  });

  test('does not treat dependency/helper ESM prose as a package ESM migration', () => {
    const negatives = [
      'perf: switch from debug to obug (smaller, esm-only)',
      'switch to an esm-only dependency',
      'use `foo`, which is now ESM-only',
      'upgraded internal helper to an ESM-only package',
    ];

    for (const text of negatives) {
      assert.equal(
        matchProse(text).some((match) => match.kind === 'module-system-change'),
        false,
        text,
      );
    }
  });

  test('recognizes package-level CommonJS compatibility announcements', () => {
    const positives = [
      'This package is now pure ESM',
      'The package is now ESM-only',
      'Dropped CommonJS support',
      'CommonJS is no longer supported',
      'require() is no longer supported',
    ];

    for (const text of positives) {
      assert.equal(
        matchProse(text).some((match) => match.kind === 'module-system-change'),
        true,
        text,
      );
    }
  });

  test('catches "Required Node.js >=14.16", not just "now requires"', () => {
    const matches = matchProse('**Required Node.js >=14.16**');
    assert.equal(matches[0]?.kind, 'runtime-requirement');
    assert.match(matches[0]!.summary, /14\.16/);
  });

  test('extracts ESM and runtime passages from a real release body', () => {
    // Verbatim from szmarczak/http-timer v5.0.0 — both of these were missed
    // until a live run against the real repository surfaced them.
    const body =
      '## This package is now pure ESM\n\nSee https://gist.github.com/x\n\n## Bug fixes\n\n- `abort` listener should be removed\n\n**Required Node.js >=14.16**';

    const passages = extractBreakingPassages(body);
    assert.ok(passages.some((p) => /pure ESM/i.test(p)));
    assert.ok(passages.some((p) => /Required Node\.js/i.test(p)));
  });

  test('does not extract bare dependency/helper esm-only prose as breaking passage', () => {
    const passages = extractBreakingPassages('- perf: switch from debug to obug (smaller, esm-only)');
    assert.equal(passages.length, 0);
  });

  test('requires backticks, so prose does not become a search symbol', () => {
    assert.equal(
      matchProse('We removed a lot of dead code in this release.').length,
      0,
      'unquoted English must not yield symbols',
    );
    assert.equal(matchProse('The old behaviour has been removed.').length, 0);
  });

  test('catches the imperative mood a commit subject is conventionally written in', () => {
    // Git convention is "Remove x", never "Removed x" — a bare imperative,
    // usually the sentence's first word. The changelog-oriented past
    // participle above does not cover this at all.
    for (const text of ['Remove `createClient`', 'remove the `createClient` helper']) {
      const matches = matchProse(text);
      assert.equal(matches[0]?.kind, 'removed-export', text);
      assert.deepEqual(matches[0]?.symbols, ['createClient'], text);
    }
  });

  test('extends the removal verb to its common synonyms, in every mood', () => {
    for (const text of ['Drop `oldFlag`', 'Dropped `oldFlag`', 'Delete `oldFlag`', 'deletes the `oldFlag` option']) {
      const matches = matchProse(text);
      assert.equal(matches[0]?.kind, 'removed-export', text);
      assert.deepEqual(matches[0]?.symbols, ['oldFlag'], text);
    }
  });

  test('recognises the Conventional Commits BREAKING CHANGE footer, symbol or not', () => {
    const withSymbol = matchProse('BREAKING CHANGE: the `createClient` factory now throws on invalid input');
    assert.ok(withSymbol.some((m) => m.kind === 'behaviour-change' && m.ruleId === 'prose-breaking-change-footer'));
    // The hyphenated spelling Conventional Commits also permits.
    assert.ok(
      matchProse('BREAKING-CHANGE: internal storage format changed').some(
        (m) => m.kind === 'behaviour-change' && m.ruleId === 'prose-breaking-change-footer',
      ),
    );

    // No backtick-quoted symbol at all — still a real declared break, not
    // silently worth nothing. `symbolGroup: 0` means an empty `symbols` here;
    // `fromProseEvidence` is what falls back to the dependency name.
    const freeform = matchProse('BREAKING CHANGE: internal storage format changed, migrate your data first');
    const footer = freeform.find((m) => m.ruleId === 'prose-breaking-change-footer');
    assert.ok(footer);
    assert.deepEqual(footer!.symbols, []);
    assert.match(footer!.summary, /internal storage format changed/);
  });

  test('the BREAKING CHANGE footer must be the marker, not just the words appearing in prose', () => {
    assert.equal(
      matchProse('This is a breaking change for some users.').some(
        (m) => m.ruleId === 'prose-breaking-change-footer',
      ),
      false,
    );
  });

  describe('signature changes are named as such, not folded into behaviour-change', () => {
    const readsSignatureChange = (line: string) =>
      matchProse(line).some((m) => m.kind === 'signature-change');

    test('"the signature of `x` changed", either word order', () => {
      assert.ok(readsSignatureChange('BREAKING CHANGE: constructor signature of `TagManager` has changed.'));
      assert.ok(readsSignatureChange('the call signature of `useSelector` changed'));
      assert.ok(readsSignatureChange('We changed the signature of the multi-series mapping function'));
      assert.ok(
        readsSignatureChange(
          'The signature of the mapping function has changed from (data, series, index) to (data, index, series)',
        ),
      );
    });

    test('"`x` no longer takes …" is a signature change, and still also a behaviour-change', () => {
      const matches = matchProse('BREAKING CHANGE: `AwsLogDriver` no longer takes construct properties.');
      assert.ok(matches.some((m) => m.kind === 'signature-change'));
      // `prose-no-longer` still fires too — a caller wants both framings.
      assert.ok(matches.some((m) => m.ruleId === 'prose-no-longer'));
    });

    test('an ordinal argument tied to a backticked symbol', () => {
      assert.ok(
        readsSignatureChange('The second argument for `useIndeterminateChecked` is now an object of options'),
      );
      assert.ok(readsSignatureChange('`onError` is no longer the second parameter of `useController`'));
    });

    test('an explicit call-shape rewrite with the same name on both sides', () => {
      assert.ok(readsSignatureChange('fetch(Resource.create(), {}, body) -> fetch(Resource.create(), body)'));
      assert.ok(
        readsSignatureChange('Refactor fetchJSON(instance = {}, url, compression) into fetchJSON(instance = {}, options)'),
      );
    });

    test('does not fire on a commit that left the signature alone', () => {
      assert.equal(readsSignatureChange('The public signature is unchanged in this release.'), false);
      assert.equal(readsSignatureChange('Document the signature of `parse` in the README.'), false);
      assert.equal(readsSignatureChange('Rename the internal helper; no signature has not changed here'), false);
      // A different function on each side of the arrow is a data-flow arrow, not a rewrite.
      assert.equal(readsSignatureChange('map(xs) -> filter(xs)'), false);
    });
  });

  describe('refinement rules only sharpen a break another rule already found', () => {
    test('a broad signature phrase alone establishes nothing', () => {
      // No symbol, no marker — the phrasing of an internal refactor subject.
      for (const line of [
        'refactor(content-docs): make readVersionsMetadata async',
        'perf: re-use options object when generating ETags',
        'chore: fix return type of findFlatConfigFile',
        'update function signatures for basic math ops',
      ]) {
        assert.deepEqual(matchProse(line), [], `expected no match for ${JSON.stringify(line)}`);
      }
    });

    test('the same phrase on a BREAKING CHANGE line is kept, and names the kind', () => {
      const matches = matchProse('BREAKING CHANGE: make Query.prototype.exec() async, drop callback support');
      assert.ok(matches.some((m) => m.ruleId === 'prose-breaking-change-footer'));
      assert.ok(matches.some((m) => m.kind === 'signature-change'));
    });

    test('a refinement rides on a symbol rule as its anchor, not only the footer', () => {
      const matches = matchProse('`render` was removed; the callback argument was removed from the new API');
      assert.ok(matches.some((m) => m.kind === 'removed-export'));
      assert.ok(matches.some((m) => m.kind === 'signature-change'));
    });

    test('anchored:true keeps a refinement whose anchor is a line or two up', () => {
      // The footer sits above the sentence in a real multi-line commit body.
      const body = matchProse('the encode method is now synchronous', { anchored: true });
      assert.ok(body.some((m) => m.kind === 'signature-change'));
      // Without the anchor, the same sentence is not evidence of a break.
      assert.deepEqual(matchProse('the encode method is now synchronous'), []);
    });
  });

  describe('declaresBreakingChange — the marker, not the words', () => {
    test('recognises the Conventional Commits footer in its real spellings', () => {
      for (const t of [
        'feat: x\n\nBREAKING CHANGE: the API moved',
        'BREAKING-CHANGE: dropped node 12',
        'BREAKING CHANGES: several',
        '*** BREAKING CHANGE ***\nObservable.from no longer supports the map fn',
        'BREAKING CHANGE - Observable.from no longer supports the optional map function',
        '## Breaking Changes\n\n- `foo` removed',
      ]) {
        assert.equal(declaresBreakingChange(t), true, JSON.stringify(t));
      }
    });

    test('does not fire on "breaking change" sitting inside a changelog bullet', () => {
      const kuzzleStyle =
        'Adapt ES service\n\n - `deleteByQuery`: **breaking change** does not return ids\n' +
        '**breaking change** `truncateCollection` does not return `acknowledged` anymore';
      assert.equal(declaresBreakingChange(kuzzleStyle), false);
    });
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

  /**
   * The zod 3 → 4 shape, reduced to its bones.
   *
   * zod 3 declares its public API as unexported locals and publishes it in one
   * renaming export statement; zod 4 declares the same names outright. Missing
   * the rename meant the old surface had no `object` at all, so the diff saw
   * the entire user-facing API as an addition — and Drift called a major
   * upgrade that broke this repository's own config schema safe.
   */
  test('reads renaming export statements as part of the surface', () => {
    const before = extractExports(
      `declare const objectType: <T extends Shape>(shape: T) => ZodObject<T, "strip">;
export { objectType as object };`,
      'a.d.ts',
    );

    assert.ok(before.has('object'), 'the published name is what a caller depends on');
    assert.ok(
      !before.get('object')!.signature.includes('objectType'),
      'the private local name is not part of the published signature',
    );

    const after = extractExports(
      'export declare function object<T extends Shape>(shape?: T, params?: Params): ZodObject<T, Config>;',
      'a.d.ts',
    );

    const changes = diffSurfaces(before, after);
    assert.ok(
      changes.some((c) => c.kind === 'signature-changed' && c.symbol === 'object'),
      'a rename on one side and a declaration on the other still compare as one symbol',
    );
    assert.ok(
      !changes.some((c) => c.kind === 'kind-changed'),
      'const-arrow to function is a source style, not a change a caller can break on',
    );
  });

  /**
   * The finding that started this: Drift told a developer `z.object` had been
   * deleted by zod 4, and dispatched an agent to replace every call site of a
   * function that is still there. The declaration was simply never extracted —
   * its type parameter list nests a `Record<…>`, and the pattern that read
   * declarations stopped at the first `>`. Its neighbours, whose type
   * parameters do not nest, came through, which is what made the wrong finding
   * look so specific.
   */
  test('extracts a function whose type parameters nest', () => {
    const api = extractExports(
      'export declare function object<T extends Shape = Partial<Record<never, SomeType>>>(shape?: T): ZodObject<T>;',
      'a.d.ts',
    );

    assert.ok(api.has('object'), 'a nested generic is still a declaration');
    assert.equal(api.get('object')?.kind, 'function');
  });

  test('a constraint containing an arrow type does not end the parameter list early', () => {
    const api = extractExports('export declare function on<T extends (event: E) => void>(handler: T): void;', 'a.d.ts');

    assert.ok(api.has('on'), '`=>` inside a constraint closes nothing');
  });

  /**
   * The truncation behind an entire zod 3 → 4 report. zod 3 spells its
   * factories `(params?: RawCreateParams & { coerce?: true; }) => ZodString`,
   * whose first `{` is nested two levels in and whose first `;` is inside it.
   * Reading that brace as the declaration's body cut the signature off before
   * its return type, and a signature that stops mid-type cannot be compared —
   * so every one of those symbols was reported as changed against call sites
   * that were already correct.
   */
  test('an inline object type inside a parameter list does not end the declaration', () => {
    const api = extractExports(
      'export declare const string: (params?: RawCreateParams & { coerce?: true; }) => ZodString;',
      'a.d.ts',
    );

    const signature = api.get('string')?.signature ?? '';
    assert.ok(signature.includes('=> ZodString'), `the return type survives: ${signature}`);
    assert.ok(signature.trimEnd().endsWith(';'), 'the declaration runs to its own terminator');
  });

  test('a body-opening brace still ends the declaration it belongs to', () => {
    const api = extractExports(
      'export interface Options { retries?: number; timeout?: number; }\nexport declare function go(): void;',
      'a.d.ts',
    );

    assert.deepEqual(api.get('Options')?.members, ['retries', 'timeout'], 'the body is still read as a body');
    assert.ok(api.has('go'), 'and it does not swallow the declaration after it');
  });

  /**
   * A call is only exposed to the parameters it actually fills. zod moved
   * `params` from `RawCreateParams & {…}` to `string | $ZodStringParams` and
   * grew a chain of overloads around it, and none of that can reach
   * `z.string()`, which passes nothing.
   */
  describe('per-call-site signature compatibility', () => {
    const zod3String = 'declare const string: (params?: RawCreateParams & { coerce?: true; }) => ZodString;';
    const zod4String =
      'export declare function string(params?: string | core.$ZodStringParams): ZodString;' +
      ' | export declare function string<T extends string>(params?: string): core.$ZodType<T, T>;';

    test('a zero-argument call survives a change to an optional parameter', () => {
      assert.equal(acceptsCallOfArity(zod3String, zod4String, 0), true);
    });

    test('an overload chain is split on declarations, not on union bars', () => {
      assert.equal(
        acceptsCallOfArity(
          'declare const f: (a?: string | number) => R;',
          'export declare function f(a?: string | number | boolean): R;',
          0,
        ),
        true,
        'a `|` inside a parameter type must not be read as an overload separator',
      );
    });

    test('a call that fills a moved parameter is still reported', () => {
      assert.equal(
        acceptsCallOfArity(
          'declare const array: <El extends ZodTypeAny>(schema: El) => ZodArray<El>;',
          'export declare function array<T extends core.SomeType>(element: T): ZodArray<T>;',
          1,
        ),
        false,
        'whether ZodTypeAny and core.SomeType agree is a question for a type checker',
      );
    });

    test('a changed return type is not excused by an empty argument list', () => {
      assert.equal(
        acceptsCallOfArity('declare const f: () => Old;', 'export declare function f(): New;', 0),
        false,
      );
    });

    test('an optional parameter that became required still breaks the call that omitted it', () => {
      assert.equal(
        acceptsCallOfArity('declare const f: (a?: X) => R;', 'export declare function f(a: X): R;', 0),
        false,
      );
    });

    /**
     * `z.string().optional()` is a method on the schema; `z.optional(type)` is
     * the free function that shares its name and requires an argument. A call
     * passing nothing never resolved to the function, so a change to the
     * function's signature is not a reason to look at that line.
     */
    test('a call the old declaration could never accept is not a site of its change', () => {
      assert.equal(
        callCannotResolveTo('declare const optional: <Inner>(type: Inner, params?: P) => ZodOptional<Inner>;', 0),
        true,
      );
    });

    test('a call the old declaration did accept is left alone', () => {
      assert.equal(
        callCannotResolveTo('declare const optional: <Inner>(type: Inner, params?: P) => ZodOptional<Inner>;', 1),
        false,
      );
    });

    test('an unparseable declaration proves nothing either way', () => {
      assert.equal(callCannotResolveTo('declare const enum: typeof createZodEnum;', 0), false);
      assert.equal(acceptsCallOfArity('declare const enum: typeof createZodEnum;', 'export declare function e(): R;', 0), false);
    });
  });

  test('a nested generic that really was removed is still reported', () => {
    const before = extractExports(
      'export declare function object<T extends Partial<Record<never, X>>>(shape: T): Y;',
      'a.d.ts',
    );
    const after = extractExports('export declare function other(): void;', 'a.d.ts');

    assert.ok(
      diffSurfaces(before, after).some((c) => c.kind === 'export-removed' && c.symbol === 'object'),
      'seeing the declaration is what makes a real removal detectable too',
    );
  });

  /**
   * The other half of the same complaint. A release that grows `f()` into
   * `f(options?)` has changed its declaration text and broken nobody, and a
   * finding there sends an agent to read code that was already correct.
   */
  test('a new trailing optional parameter is not a breaking change', () => {
    const before = extractExports('export declare function parse(input: string): Result;', 'a.d.ts');
    const after = extractExports('export declare function parse(input: string, options?: Options): Result;', 'a.d.ts');

    assert.deepEqual(diffSurfaces(before, after), [], 'a caller cannot break on an argument it never passes');
  });

  test('a required parameter that became optional is not a breaking change', () => {
    const before = extractExports('export declare function parse(input: string): Result;', 'a.d.ts');
    const after = extractExports('export declare function parse(input?: string): Result;', 'a.d.ts');

    assert.deepEqual(diffSurfaces(before, after), []);
  });

  test('a new trailing rest parameter is not a breaking change', () => {
    const before = extractExports('export declare function log(message: string): void;', 'a.d.ts');
    const after = extractExports('export declare function log(message: string, ...rest: unknown[]): void;', 'a.d.ts');

    assert.deepEqual(diffSurfaces(before, after), []);
  });

  test('a reordered parameter list is reported', () => {
    const before = extractExports('export declare function f(a: A): R;', 'a.d.ts');
    const after = extractExports('export declare function f(b: B, a: A): R;', 'a.d.ts');

    assert.ok(
      diffSurfaces(before, after).some((c) => c.kind === 'signature-changed'),
      'every existing call now passes its argument in the wrong position',
    );
  });

  test('an optional parameter that became required is reported', () => {
    const before = extractExports('export declare function f(a?: A): R;', 'a.d.ts');
    const after = extractExports('export declare function f(a: A): R;', 'a.d.ts');

    assert.ok(diffSurfaces(before, after).some((c) => c.kind === 'signature-changed'));
  });

  test('a new *required* parameter is reported', () => {
    const before = extractExports('export declare function f(a: A): R;', 'a.d.ts');
    const after = extractExports('export declare function f(a: A, b: B): R;', 'a.d.ts');

    assert.ok(diffSurfaces(before, after).some((c) => c.kind === 'signature-changed'));
  });

  test('a changed return type is reported even when every parameter survived', () => {
    const before = extractExports('export declare function f(a: A): R;', 'a.d.ts');
    const after = extractExports('export declare function f(a: A, b?: B): Q;', 'a.d.ts');

    assert.ok(
      diffSurfaces(before, after).some((c) => c.kind === 'signature-changed'),
      'a caller assigns the result',
    );
  });

  test('a changed parameter type is reported', () => {
    const before = extractExports('export declare function f(a: A): R;', 'a.d.ts');
    const after = extractExports('export declare function f(a: B, c?: C): R;', 'a.d.ts');

    assert.ok(diffSurfaces(before, after).some((c) => c.kind === 'signature-changed'));
  });

  test('the same relaxation is recognised in const-arrow form', () => {
    const before = extractExports('export declare const f: (a: A) => R;', 'a.d.ts');
    const after = extractExports('export declare const f: (a: A, b?: B) => R;', 'a.d.ts');

    assert.deepEqual(diffSurfaces(before, after), []);
  });

  test('an overload chain is reported rather than compared position by position', () => {
    const before = extractExports('export declare function f(a: A): R;', 'a.d.ts');
    const after = extractExports(
      'export declare function f(a: A): R;\nexport declare function f(a: A, b: B): R;',
      'a.d.ts',
    );

    assert.ok(
      diffSurfaces(before, after).some((c) => c.kind === 'signature-changed'),
      'guessing which overload answers which is the confidence this must not have',
    );
  });

  /**
   * The loudest false positive a surface diff can produce, because one tidy-up
   * makes N findings: a library lifts shared members into a base interface and
   * every lifted member is reported as removed. A caller does not care which
   * link of the chain declares `get()`, only that `client.get()` compiles.
   */
  test('members lifted into a base interface have not been removed', () => {
    const before = extractExports('export interface Client { get(): void; post(): void; }', 'a.d.ts');
    const after = extractExports(
      'export interface Base { get(): void; post(): void; }\nexport interface Client extends Base {}',
      'a.d.ts',
    );

    assert.deepEqual(diffSurfaces(before, after), []);
  });

  test('a member removed from the base is still removed from the derived type', () => {
    const before = extractExports(
      'export interface Base { get(): void; post(): void; }\nexport interface Client extends Base {}',
      'a.d.ts',
    );
    const after = extractExports(
      'export interface Base { get(): void; }\nexport interface Client extends Base {}',
      'a.d.ts',
    );

    assert.ok(
      diffSurfaces(before, after).some((c) => c.symbol === 'Client.post'),
      'inheritance must not become a place breakage hides',
    );
  });

  test('a base outside this surface costs nothing', () => {
    const api = extractExports('export interface Client extends SomethingElsewhere { get(): void; }', 'a.d.ts');

    assert.deepEqual(api.get('Client')?.members, ['get'], 'unresolved bases leave the answer unchanged');
  });

  test('an interface rewritten as a type alias is the same declaration', () => {
    const before = extractExports('export interface Options { retries?: number; timeout: number; }', 'a.d.ts');
    const after = extractExports('export type Options = { retries?: number; timeout: number; };', 'a.d.ts');

    assert.deepEqual(diffSurfaces(before, after), [], 'which keyword the author used is not a finding about their API');
  });

  test('a type alias that lost a member is reported', () => {
    const before = extractExports('export type Options = { a: string; b: string; };', 'a.d.ts');
    const after = extractExports('export type Options = { a: string; };', 'a.d.ts');

    assert.ok(
      diffSurfaces(before, after).some((c) => c.kind === 'member-removed' && c.symbol === 'Options.b'),
      'a type alias has members to lose, and losing one used to be invisible',
    );
  });

  test('a type alias that is not an object literal claims no members', () => {
    const api = extractExports('export type Id = string;\nexport type Both = A & B;', 'a.d.ts');

    assert.deepEqual(api.get('Id')?.members, [], 'nothing to see is not the same as nothing there');
    assert.deepEqual(api.get('Both')?.members, [], 'an intersection names members this cannot read from here');
  });

  test('a class rewritten as an interface is still reported', () => {
    const before = extractExports('export declare class Client { get(): void; }', 'a.d.ts');
    const after = extractExports('export interface Client { get(): void; }', 'a.d.ts');

    assert.ok(
      diffSurfaces(before, after).some((c) => c.kind === 'kind-changed'),
      '`new Client()` and `extends Client` stop compiling',
    );
  });

  test('a parameter that grew to accept more is not a breaking change', () => {
    const before = extractExports('export declare function f(a: A): R;', 'a.d.ts');
    const after = extractExports('export declare function f(a: A | B): R;', 'a.d.ts');

    assert.deepEqual(diffSurfaces(before, after), [], 'a parameter is where accepting more is safe');
  });

  test('a parameter that stopped accepting one of its types is reported', () => {
    const before = extractExports('export declare function f(a: A | B): R;', 'a.d.ts');
    const after = extractExports('export declare function f(a: A): R;', 'a.d.ts');

    assert.ok(diffSurfaces(before, after).some((c) => c.kind === 'signature-changed'));
  });

  test('a *return* type that grew is reported', () => {
    const before = extractExports('export declare function f(): A;', 'a.d.ts');
    const after = extractExports('export declare function f(): A | B;', 'a.d.ts');

    assert.ok(
      diffSurfaces(before, after).some((c) => c.kind === 'signature-changed'),
      'widening is only safe on the way in; a caller assigning the result breaks',
    );
  });

  test('a rename pointing at another file is deferred, not guessed at', () => {
    const api = new Map();
    const aliases: { exported: string; local: string }[] = [];
    extractExports('export { stringType as string } from "./types.js";', 'index.d.ts', api, aliases);
    extractExports('export declare const stringType: () => ZodString;', 'types.d.ts', api, aliases);

    assert.ok(!api.has('string'), 'unresolved until every source has been read');
    assert.deepEqual(aliases, [{ exported: 'string', local: 'stringType' }]);
  });

  test('an export that renames something published elsewhere is not invented', () => {
    const api = extractExports('export { missing as gone } from "./nowhere.js";', 'index.d.ts');
    assert.equal(api.size, 0, 'an unresolvable alias is absent, never a fabricated symbol');
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

  test('module-system dedupe preserves package-wide, exact, and wildcard scopes', async () => {
    const evidence = [
      {
        id: 'ev_module_a',
        source: 'type-surface-diff' as const,
        dependency: 'acme-sdk',
        title: 'module diff',
        content: 'module compatibility changed',
        weight: 1,
        findings: [
          {
            code: 'exports-require-condition-removed',
            symbol: 'acme-sdk',
            detail: 'The CommonJS export condition for ./foo was removed',
            moduleSystem: {
              from: 'dual' as const,
              to: 'esm' as const,
              incompatibleUsage: ['require' as const],
              affectedSpecifiers: ['acme-sdk/foo'],
            },
          },
          {
            code: 'exports-require-condition-removed',
            symbol: 'acme-sdk',
            detail: 'The CommonJS export condition for ./features/* was removed',
            moduleSystem: {
              from: 'dual' as const,
              to: 'esm' as const,
              incompatibleUsage: ['require' as const],
              affectedSpecifierPatterns: ['acme-sdk/features/*'],
            },
          },
        ],
      },
      {
        id: 'ev_module_b',
        source: 'changelog' as const,
        dependency: 'acme-sdk',
        title: 'release notes',
        content: 'This package is now ESM-only.',
        weight: 0.7,
      },
    ];

    const result = await analyze([change], evidence, { config: DEFAULT_CONFIG, logger });
    const moduleChanges = result.filter((entry) => entry.kind === 'module-system-change');

    assert.equal(moduleChanges.length, 3);
    assert.ok(moduleChanges.some((entry) => entry.moduleSystem?.affectedSpecifiers?.includes('acme-sdk/foo')));
    assert.ok(moduleChanges.some((entry) => entry.moduleSystem?.affectedSpecifierPatterns?.includes('acme-sdk/features/*')));
    assert.ok(moduleChanges.some((entry) => !entry.moduleSystem?.affectedSpecifiers && !entry.moduleSystem?.affectedSpecifierPatterns));
    assert.equal(new Set(moduleChanges.map((entry) => entry.id)).size, 3);
  });

  test('a constant-value-changed finding gets constant-specific remediation, not signature wording', async () => {
    const evidence = [
      {
        id: 'ev_const',
        source: 'type-surface-diff' as const,
        dependency: 'acme-sdk',
        title: 'surface diff',
        content: 'the constant changed',
        weight: 1,
        findings: [
          {
            code: 'constant-value-changed',
            symbol: 'linux.WebviewGpuPolicyAlways',
            detail: 'The constant `linux.WebviewGpuPolicyAlways` changed value.',
            before: 'const WebviewGpuPolicyAlways WebviewGpuPolicy = 0',
            after: 'const WebviewGpuPolicyAlways WebviewGpuPolicy = 1',
          },
        ],
      },
    ];

    const result = await analyze([change], evidence, { config: DEFAULT_CONFIG, logger });
    assert.equal(result.length, 1);
    assert.equal(result[0]?.kind, 'signature-change');
    assert.doesNotMatch(result[0]!.remediation, /argument order|argument count|positional arguments/);
    assert.match(result[0]!.remediation, /concrete value|hard-coded|persisted|zero/i);
  });

  test('a signature-changed finding never repeats before/after in its own remediation text', async () => {
    // The diff itself is rendered separately, both in the panel and in the
    // markdown report (see report/markdown.ts) — a remediation that quotes
    // `before`/`after` again says the same thing twice.
    const evidence = [
      {
        id: 'ev_sig',
        source: 'type-surface-diff' as const,
        dependency: 'acme-sdk',
        title: 'surface diff',
        content: 'the signature changed',
        weight: 1,
        findings: [
          {
            code: 'signature-changed',
            symbol: 'run',
            detail: 'The signature of `run` changed.',
            before: 'export function run(): Result;',
            after: 'export function run(): Outcome;',
            changed: 'return-type' as const,
          },
        ],
      },
    ];

    const result = await analyze([change], evidence, { config: DEFAULT_CONFIG, logger });
    assert.equal(result.length, 1);
    assert.doesNotMatch(result[0]!.remediation, /\bbefore:|\bafter:/);
  });

  test('a return-type-only change tells the reader a static checker will catch it and a dynamic one will not', async () => {
    const evidence = [
      {
        id: 'ev_ret',
        source: 'type-surface-diff' as const,
        dependency: 'acme-sdk',
        title: 'surface diff',
        content: 'the signature changed',
        weight: 1,
        findings: [
          {
            code: 'signature-changed',
            symbol: 'run',
            detail: 'The signature of `run` changed.',
            before: 'export function run(): Result;',
            after: 'export function run(): Outcome;',
            changed: 'return-type' as const,
          },
        ],
      },
    ];

    const result = await analyze([change], evidence, { config: DEFAULT_CONFIG, logger });
    assert.doesNotMatch(result[0]!.remediation, /argument order|argument count/);
    assert.match(result[0]!.remediation, /statically typed/i);
    assert.match(result[0]!.remediation, /dynamically typed/i);
  });

  test('a parameters-only change is not told to go check the return value', async () => {
    const evidence = [
      {
        id: 'ev_params',
        source: 'type-surface-diff' as const,
        dependency: 'acme-sdk',
        title: 'surface diff',
        content: 'the signature changed',
        weight: 1,
        findings: [
          {
            code: 'signature-changed',
            symbol: 'run',
            detail: 'The signature of `run` changed.',
            before: 'export function run(a: string): Result;',
            after: 'export function run(a: string, b: string): Result;',
            changed: 'parameters' as const,
          },
        ],
      },
    ];

    const result = await analyze([change], evidence, { config: DEFAULT_CONFIG, logger });
    assert.match(result[0]!.remediation, /parameters of `run` changed/);
    assert.doesNotMatch(result[0]!.remediation, /statically typed|dynamically typed/i);
  });

  test('a class-to-function kind change says to remove `new`, not the generic taxonomy sentence', async () => {
    const evidence = [
      {
        id: 'ev_kind',
        source: 'type-surface-diff' as const,
        dependency: 'acme-sdk',
        title: 'surface diff',
        content: 'the kind changed',
        weight: 1,
        findings: [
          {
            code: 'kind-changed',
            symbol: 'Client',
            detail: '`Client` changed from a class to a function.',
            before: 'declare class Client {}',
            after: 'declare function Client(): ClientHandle;',
            fromKind: 'class',
            toKind: 'function',
          },
        ],
      },
    ];

    const result = await analyze([change], evidence, { config: DEFAULT_CONFIG, logger });
    assert.match(result[0]!.remediation, /Remove `new` from every construction site/);
    assert.match(result[0]!.remediation, /new Client\(\.\.\.\)/);
    assert.doesNotMatch(result[0]!.remediation, /for example class to function/);
  });

  test('a function-to-class kind change says to add `new`, the opposite fix for the same finding code', async () => {
    const evidence = [
      {
        id: 'ev_kind2',
        source: 'type-surface-diff' as const,
        dependency: 'acme-sdk',
        title: 'surface diff',
        content: 'the kind changed',
        weight: 1,
        findings: [
          {
            code: 'kind-changed',
            symbol: 'Client',
            detail: '`Client` changed from a function to a class.',
            fromKind: 'function',
            toKind: 'class',
          },
        ],
      },
    ];

    const result = await analyze([change], evidence, { config: DEFAULT_CONFIG, logger });
    assert.match(result[0]!.remediation, /Add `new` at every call site/);
    assert.doesNotMatch(result[0]!.remediation, /Remove `new`/);
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

describe('search symbols derived from a computed finding', () => {
  const symbolsFor = async (symbol: string): Promise<string[]> => {
    const changes = await analyze(
      [{ name: 'dep', ecosystem: 'go', from: '1', to: '2', kind: 'runtime', bump: 'minor', manifestPath: 'go.mod' } as never],
      [
        {
          id: 'ev1',
          source: 'type-surface-diff',
          dependency: 'dep',
          title: 't',
          content: 'c',
          weight: 1,
          findings: [{ code: 'member-removed', symbol, detail: 'd' }],
        } as never,
      ],
      { config: DEFAULT_CONFIG, logger: createLogger('silent') },
    );
    return changes[0]!.symbols.sort();
  };

  test('a two-part member yields the qualified name and the bare member, never the bare owner', async () => {
    // The owner half of a two-part symbol is indistinguishable from a bare
    // package/namespace qualifier (`linux.WebviewGpuPolicyAlways` has the same
    // shape as `Client.request`), so it must never become a search symbol on
    // its own — see the `linux` case below.
    assert.deepEqual(await symbolsFor('Client.request'), ['Client.request', 'request']);
  });

  test('a two-part Go constant does not match a bare package-qualified line', async () => {
    const symbols = await symbolsFor('linux.WebviewGpuPolicyAlways');
    assert.equal(symbols.includes('linux'), false);
    assert.deepEqual(symbols, ['WebviewGpuPolicyAlways', 'linux.WebviewGpuPolicyAlways']);
  });

  test('importing the linux package alone is not usage of one of its constants', async () => {
    const symbols = await symbolsFor('linux.WebviewGpuPolicyAlways');
    const importLine = '"github.com/wailsapp/wails/v2/pkg/options/linux"';
    const structLine = 'Linux: &linux.Options{';
    for (const symbol of symbols) {
      assert.equal(importLine.includes(symbol), false, `"${symbol}" should not match the bare import line`);
      assert.equal(structLine.includes(symbol), false, `"${symbol}" should not match unrelated use of the package`);
    }
  });

  test('an actual use of the two-part constant is still localized', async () => {
    const symbols = await symbolsFor('linux.WebviewGpuPolicyAlways');
    const usageLine = 'GpuPolicy: linux.WebviewGpuPolicyAlways,';
    assert.ok(symbols.some((symbol) => usageLine.includes(symbol)));
  });

  test('a package qualifier is never searched on its own', async () => {
    // `unix` matches the import line of every file that uses the module, which
    // reported a repository whose only call was `unix.Getpid()` as affected by
    // a change to a netlink struct it never touches.
    const symbols = await symbolsFor('unix.NexthopGrp.Resvd1');
    assert.equal(symbols.includes('unix'), false);
    assert.deepEqual(symbols, ['NexthopGrp.Resvd1', 'Resvd1', 'unix.NexthopGrp.Resvd1']);
  });

  test('a counted aggregate is not split into an identifier', async () => {
    // "golang.org/x/sys constants" is a label, not a symbol; splitting it on
    // its dots produced `golang`, which matched every import of the module.
    assert.deepEqual(await symbolsFor('golang.org/x/sys constants'), ['golang.org/x/sys constants']);
  });
});
