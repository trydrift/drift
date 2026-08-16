import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractWithLlm } from '../dist/analyze/llm.js';
import { DriftConfigSchema } from '../dist/config/schema.js';
import type { DependencyChange, Evidence } from '../dist/types.js';

/**
 * The optional LLM extraction pass.
 *
 * This is the one evidence source that can be wrong in a way the others
 * cannot: it reads prose and writes findings, so its failure modes are
 * fabrication and silence. Both are pinned here.
 *
 * The citation invariant is the load-bearing one. A finding whose `evidenceId`
 * does not name evidence Drift actually holds is unverifiable by the reviewer
 * it is shown to, so it is dropped rather than downgraded — and the tests below
 * check that it is dropped even when everything else about it looks plausible.
 */

const config = DriftConfigSchema.parse({ llm: { enabled: true } });

/** Captures warnings so "said nothing" is distinguishable from "said why". */
function recordingLogger() {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (m: string) => warnings.push(m),
      error: () => undefined,
      group: async <T>(_n: string, fn: () => Promise<T>) => fn(),
    },
  };
}

/** A client that answers every request with one canned response. */
function clientReturning(response: {
  content: { type: string; text?: string }[];
  stop_reason?: string | null;
}) {
  return { messages: { create: async () => response } };
}

/** A client whose single text block is the given JSON. */
function clientAnswering(body: unknown) {
  return clientReturning({ content: [{ type: 'text', text: JSON.stringify(body) }] });
}

const change: DependencyChange = {
  name: 'acme',
  ecosystem: 'npm',
  from: '1.0.0',
  to: '2.0.0',
  bump: 'major',
} as DependencyChange;

const evidence: Evidence[] = [
  {
    id: 'ev-1',
    source: 'changelog',
    dependency: 'acme',
    locator: 'CHANGELOG.md',
    title: 'v2.0.0',
    content: 'We have reworked how clients are constructed.',
    weight: 0.65,
  } as Evidence,
];

const finding = {
  summary: 'The client constructor changed.',
  remediation: 'Update every construction site.',
  symbols: ['createClient'],
  kind: 'signature-change',
  evidenceId: 'ev-1',
};

async function run(client: unknown, ev: Evidence[] = evidence) {
  const { logger, warnings } = recordingLogger();
  const found = await extractWithLlm([change], ev, [], {
    config,
    logger: logger as never,
    client: client as never,
  });
  return { found, warnings };
}

describe('extracting breaking changes from prose with a model', () => {
  test('a well-formed finding becomes a breaking change, capped below high confidence', async () => {
    const { found } = await run(clientAnswering({ changes: [finding] }));

    assert.equal(found.length, 1);
    assert.equal(found[0]?.summary, 'The client constructor changed.');
    assert.deepEqual(found[0]?.symbols, ['createClient']);
    assert.notEqual(
      found[0]?.confidence,
      'high',
      'an LLM-only finding must never clear the automatic-dispatch gate on its own',
    );
  });

  test('an empty list is an ordinary answer, not a warning', async () => {
    const { found, warnings } = await run(clientAnswering({ changes: [] }));

    assert.deepEqual(found, []);
    assert.deepEqual(warnings, [], 'the model read the prose and found nothing — that is a result');
  });

  test('a finding citing evidence Drift does not hold is dropped', async () => {
    // The fabrication guard. A reviewer cannot check a citation that points at
    // nothing, so the finding is worth less than nothing.
    const { found } = await run(
      clientAnswering({ changes: [{ ...finding, evidenceId: 'ev-does-not-exist' }] }),
    );

    assert.deepEqual(found, []);
  });

  test('a refusal is reported, never returned as "found nothing"', async () => {
    const { found, warnings } = await run(
      clientReturning({ content: [], stop_reason: 'refusal' }),
    );

    assert.deepEqual(found, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /declined/i);
    assert.match(warnings[0] ?? '', /acme/, 'the warning must name what went unanalysed');
  });

  test('an answer that is not JSON is reported', async () => {
    const { found, warnings } = await run(
      clientReturning({ content: [{ type: 'text', text: 'Sure! Here you go:' }] }),
    );

    assert.deepEqual(found, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /JSON/);
  });

  test('an answer with no text block is reported, with the stop reason', async () => {
    const { found, warnings } = await run(
      clientReturning({ content: [], stop_reason: 'max_tokens' }),
    );

    assert.deepEqual(found, []);
    assert.match(warnings[0] ?? '', /max_tokens/);
  });

  test('valid JSON carrying no changes array is reported', async () => {
    const { found, warnings } = await run(clientAnswering({ result: 'ok' }));

    assert.deepEqual(found, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /changes/);
  });

  test('a model outage never fails the run — the rules already produced output', async () => {
    const exploding = { messages: { create: async () => { throw new Error('503 overloaded'); } } };
    const { found, warnings } = await run(exploding);

    assert.deepEqual(found, []);
    assert.match(warnings[0] ?? '', /503 overloaded/);
  });

  test('computed evidence is never re-read through the model', async () => {
    // A structured diff is already exact. Passing it through prose extraction
    // could only lose findings or invent them.
    let called = false;
    const client = {
      messages: {
        create: async () => {
          called = true;
          return { content: [{ type: 'text', text: '{"changes":[]}' }] };
        },
      },
    };
    const computed: Evidence[] = [
      {
        ...evidence[0]!,
        source: 'type-surface-diff',
        findings: [{ code: 'removed-export', symbol: 'createClient', detail: 'gone' }],
      } as Evidence,
    ];

    await run(client, computed);

    assert.equal(called, false);
  });
});
