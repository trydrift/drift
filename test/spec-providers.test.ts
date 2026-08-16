import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { gatherEvidence } from '../dist/evidence/index.js';
import {
  SPEC_EVIDENCE_SOURCES,
  SPEC_PROVIDERS,
  isSpecEvidenceSource,
  specCodeFor,
} from '../dist/evidence/spec/index.js';
import { DriftConfigSchema } from '../dist/config/schema.js';
import { classify } from '../dist/confidence/taxonomy.js';
import { kindForFindingCode, remediationForFinding } from '../dist/analyze/rules.js';
import { createLogger } from '../dist/util/logger.js';

/**
 * The contract-diff provider interface, and OpenAPI as its first implementation.
 *
 * Two things are pinned here. The first is that generalising the OpenAPI differ
 * into a `SpecProvider` changed nothing a consumer can observe: the same
 * evidence id, source, title, weight and findings come out of `gatherEvidence`
 * for the same pair of documents.
 *
 * The second is the invariant that makes adding a format safe — every code a
 * provider can emit is classified, has a fix-strategy kind, and has remediation
 * text. Before this, those three answers lived in three files that knew nothing
 * about each other, and a forgotten entry degraded silently: a finding with no
 * taxonomy is classified `default`, which reads as "we could not tell" rather
 * than as "nobody registered this code".
 */

const logger = createLogger('error');

const BASE_SPEC = {
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

function configWith(evidence: Record<string, unknown>) {
  return DriftConfigSchema.parse({ evidence });
}

/** A repo whose one file is `path`, with different content at each commit. */
function repoWith(path: string, before: string, after: string) {
  return async (requested: string, ref: string): Promise<string | null> => {
    if (requested !== path) return null;
    return ref === 'before' ? before : after;
  };
}

describe('contract documents, gathered through the provider interface', () => {
  const path = 'api/openapi.json';

  async function gather(before: unknown, after: unknown, evidence: Record<string, unknown> = {}) {
    return gatherEvidence([], {
      config: configWith({ openapi: true, openapiSpecs: [path], ...evidence }),
      logger,
      readRepoFile: repoWith(path, JSON.stringify(before), JSON.stringify(after)),
      beforeSha: 'before',
      afterSha: 'after',
    });
  }

  test('a removed operation is recorded as openapi-diff evidence, unchanged', async () => {
    const after = structuredClone(BASE_SPEC);
    delete (after.paths['/users/{id}'] as Record<string, unknown>).delete;

    const records = await gatherEvidence([], {
      config: configWith({ openapi: true, openapiSpecs: [path] }),
      logger,
      readRepoFile: repoWith(path, JSON.stringify(BASE_SPEC), JSON.stringify(after)),
      beforeSha: 'before',
      afterSha: 'after',
    });

    assert.equal(records.length, 1);
    const record = records[0]!;
    assert.equal(record.source, 'openapi-diff');
    assert.equal(record.dependency, path);
    assert.equal(record.locator, path);
    assert.equal(record.weight, 1);
    assert.match(record.title, /breaking change\(s\) in api\/openapi\.json$/);
    assert.ok(
      record.findings?.some(
        (finding) => finding.code === 'operation-removed' && finding.symbol.includes('DELETE'),
      ),
      'the structured finding must survive the provider indirection',
    );
    // The rendered content is what a reviewer reads, and its shape is part of
    // the report's stable output.
    assert.match(record.content, /^- `DELETE \/users\/\{id\}` — /m);
  });

  test('a purely additive change produces no evidence at all', async () => {
    const after = structuredClone(BASE_SPEC);
    (after.paths['/users/{id}'].get.responses['200'].content['application/json'].schema
      .properties as Record<string, unknown>).createdAt = { type: 'string' };

    assert.deepEqual(await gather(BASE_SPEC, after), []);
  });

  test('an identical document is not diffed', async () => {
    assert.deepEqual(await gather(BASE_SPEC, BASE_SPEC), []);
  });

  test('a document that is not a spec is left alone', async () => {
    assert.deepEqual(await gather({ a: 1 }, { a: 2 }), []);
  });

  test('the provider is skipped entirely when its config flag is off', async () => {
    const after = structuredClone(BASE_SPEC);
    delete (after.paths['/users/{id}'] as Record<string, unknown>).delete;

    assert.deepEqual(await gather(BASE_SPEC, after, { openapi: false }), []);
  });

  test('a comparison that ran is reported even when it found nothing', async () => {
    const after = structuredClone(BASE_SPEC);
    (after.paths['/users/{id}'].get.responses['200'].content['application/json'].schema
      .properties as Record<string, unknown>).createdAt = { type: 'string' };

    const compared: string[] = [];
    await gatherEvidence([], {
      config: configWith({ openapi: true, openapiSpecs: [path] }),
      logger,
      readRepoFile: repoWith(path, JSON.stringify(BASE_SPEC), JSON.stringify(after)),
      beforeSha: 'before',
      afterSha: 'after',
      onSpecComputed: (comparedPath) => compared.push(comparedPath),
    });

    assert.deepEqual(compared, [path], '"diffed and clean" must be distinguishable from "not diffed"');
  });
});

describe('the provider registry', () => {
  test('every declared source has exactly one provider, and vice versa', () => {
    const declared = [...SPEC_EVIDENCE_SOURCES].sort();
    const registered = SPEC_PROVIDERS.map((provider) => provider.source).sort();
    assert.deepEqual(
      registered,
      declared,
      'SPEC_EVIDENCE_SOURCES and SPEC_PROVIDERS must agree — one of the two lists was not updated',
    );
    assert.equal(new Set(registered).size, registered.length, 'two providers claim the same source');
  });

  test('every provider declares a weight, an origin class and config keys', () => {
    for (const provider of SPEC_PROVIDERS) {
      assert.ok(provider.weight > 0 && provider.weight <= 1, `${provider.id} has an implausible weight`);
      assert.ok(provider.originClass.length > 0, `${provider.id} declares no origin class`);
      assert.ok(provider.config.enabled, `${provider.id} declares no enable flag`);
      assert.ok(provider.config.paths, `${provider.id} declares no path list`);
      assert.ok(Object.keys(provider.codes).length > 0, `${provider.id} declares no finding codes`);
    }
  });

  test('every provider config key exists in the schema', () => {
    const config = DriftConfigSchema.parse({});
    for (const provider of SPEC_PROVIDERS) {
      const evidence = config.evidence as Record<string, unknown>;
      assert.equal(
        typeof evidence[provider.config.enabled],
        'boolean',
        `config.evidence.${String(provider.config.enabled)} is missing from the schema`,
      );
      assert.ok(
        Array.isArray(evidence[provider.config.paths]),
        `config.evidence.${String(provider.config.paths)} is missing from the schema`,
      );
    }
  });

  test('no two providers claim the same finding code', () => {
    const seen = new Map<string, string>();
    for (const provider of SPEC_PROVIDERS) {
      for (const code of Object.keys(provider.codes)) {
        const owner = seen.get(code);
        assert.equal(owner, undefined, `${code} is claimed by both ${owner} and ${provider.id}`);
        seen.set(code, provider.id);
      }
    }
  });

  test('every registered code is classified, mapped and remediated', () => {
    for (const provider of SPEC_PROVIDERS) {
      for (const code of Object.keys(provider.codes)) {
        const taxonomy = classify(kindForFindingCode(code), code);
        assert.equal(
          taxonomy.origin,
          'computed',
          `${code} falls through to the kind-based default instead of the provider's own classification`,
        );

        assert.notEqual(kindForFindingCode(code), 'unknown', `${code} has no fix-strategy kind`);

        const remediation = remediationForFinding(
          { code, symbol: 'Thing.field', detail: 'It changed.' },
          'api/schema',
        );
        assert.ok(remediation.includes('Thing.field'), `${code} has generic remediation text`);
        assert.ok(
          !remediation.startsWith('Review usages of'),
          `${code} falls through to the generic remediation fallback`,
        );
      }
    }
  });

  test('spec sources are recognised by the analyser', () => {
    for (const provider of SPEC_PROVIDERS) {
      assert.ok(isSpecEvidenceSource(provider.source));
      assert.ok(specCodeFor(Object.keys(provider.codes)[0]!));
    }
    assert.equal(isSpecEvidenceSource('type-surface-diff'), false);
  });
});
