import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { failureReason, parseCodexModels } from '../src/agents/cli.js';

/**
 * Regression tests for a fix run that could not have succeeded.
 *
 * Drift offered `gpt-5-codex`, a model ChatGPT accounts had already lost access
 * to. Choosing it produced a 400 from the API, and the message the panel showed
 * was `warning: --full-auto is deprecated` — the first line Codex printed, and
 * nothing to do with why the run died. The developer's reasonable conclusion
 * was that Drift is broken.
 *
 * Both halves are pinned here: the roster comes from the install, and the
 * reported cause is the cause.
 */

describe('the models a Codex install can actually reach', () => {
  const cache = JSON.stringify({
    models: [
      {
        slug: 'gpt-5.4',
        display_name: 'GPT-5.4',
        description: 'The previous frontier model.',
        visibility: 'list',
        priority: 16,
        supported_reasoning_levels: [
          { effort: 'low', description: 'Fast responses with lighter reasoning' },
          { effort: 'high', description: 'Greater reasoning depth for complex problems' },
        ],
      },
      {
        slug: 'gpt-5.5',
        display_name: 'GPT-5.5',
        visibility: 'list',
        priority: 7,
        supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'xhigh' }],
      },
      { slug: 'gpt-5-codex', display_name: 'GPT-5 Codex', visibility: 'hidden', priority: 1 },
    ],
  });

  test('offers what the roster lists, in the order the roster ranks it', () => {
    const models = parseCodexModels(cache);
    assert.deepEqual(
      models.map((m) => m.id),
      ['gpt-5.5', 'gpt-5.4'],
      'a hidden slug is a retired alias, not an offer',
    );
    assert.equal(models[0]?.label, 'GPT-5.5');
  });

  test('takes each model’s reasoning dial from the model, in Codex’s words', () => {
    const [top, previous] = parseCodexModels(cache);

    assert.deepEqual(
      previous?.efforts?.map((e) => e.value),
      ['low', 'high'],
      'a model that supports two stops must not be offered four',
    );
    assert.equal(previous?.efforts?.[0]?.detail, 'Fast responses with lighter reasoning');
    // No description in the roster: Drift's own wording for that stop stands.
    assert.equal(top?.efforts?.[0]?.value, 'medium');
    assert.ok(top?.efforts?.[0]?.detail);
  });

  test('an unreadable roster offers nothing rather than something wrong', () => {
    assert.throws(() => parseCodexModels('not json'));
    assert.deepEqual(parseCodexModels('{}'), []);
  });
});

describe('why the agent actually failed', () => {
  test('skips the deprecation warning and reports the API’s refusal', () => {
    const stderr = [
      'warning: `--full-auto` is deprecated; use `--sandbox workspace-write` instead.',
      'warning: Model metadata for `gpt-5-codex` not found. Defaulting to fallback metadata.',
      'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5-codex\' model is not supported when using Codex with a ChatGPT account."}}',
    ].join('\n');

    assert.equal(
      failureReason(stderr, ''),
      "The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.",
    );
  });

  test('falls back to the first real line when nothing announces itself as an error', () => {
    assert.equal(failureReason('', 'warning: deprecated\nsomething went sideways'), 'something went sideways');
  });

  test('says so plainly when the agent printed nothing at all', () => {
    assert.equal(failureReason('', ''), 'No output.');
  });
});
