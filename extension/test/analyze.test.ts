import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DriftConfigSchema } from '../../src/config/schema.js';
import { resolveScanChoices, type ScanChoicePromptOption } from '../src/analyze.js';
import { __settings } from './vscode-stub.js';

function config(dev = true) {
  return DriftConfigSchema.parse({ triggerOn: { dev } });
}

async function resolve(answer: string) {
  const prompts: { question: string; options: ScanChoicePromptOption[] }[] = [];
  const choices = await resolveScanChoices(config(), async (question, options) => {
    prompts.push({ question, options });
    return answer;
  });
  return { choices, prompts };
}

beforeEach(() => {
  __settings.clear();
});

describe('resolveScanChoices', () => {
  test('combines depth and dependency scope into one question when both are ask', async () => {
    __settings.set('analysis.verifyMode', 'ask');
    __settings.set('analysis.dependencyScope', 'ask');

    const expected = [
      ['quick:runtime+dev', { deep: false, includeDev: true }],
      ['quick:runtime', { deep: false, includeDev: false }],
      ['deep:runtime+dev', { deep: true, includeDev: true }],
      ['deep:runtime', { deep: true, includeDev: false }],
    ] as const;

    for (const [answer, choices] of expected) {
      const result = await resolve(answer);
      assert.deepEqual(result.choices, choices);
      assert.equal(result.prompts.length, 1);
      assert.equal(result.prompts[0]!.question, 'How should I scan your dependencies?');
      assert.deepEqual(
        result.prompts[0]!.options.map((option) => option.value),
        ['quick:runtime+dev', 'quick:runtime', 'deep:runtime+dev', 'deep:runtime'],
      );
      assert.deepEqual(
        result.prompts[0]!.options.map((option) => option.label),
        [
          'Quick Scan · Runtime + dev',
          'Quick Scan · Runtime only',
          'Deep Verification · Runtime + dev',
          'Deep Verification · Runtime only',
        ],
      );
    }
  });

  test('asks only depth when scope is explicitly runtime', async () => {
    __settings.set('analysis.verifyMode', 'ask');
    __settings.set('analysis.dependencyScope', 'runtime');

    const { choices, prompts } = await resolve('deep');

    assert.deepEqual(choices, { deep: true, includeDev: false });
    assert.equal(prompts.length, 1);
    assert.deepEqual(prompts[0]!.options.map((option) => option.value), ['quick', 'deep']);
  });

  test('asks only depth when scope is explicitly runtime+dev', async () => {
    __settings.set('analysis.verifyMode', 'ask');
    __settings.set('analysis.dependencyScope', 'runtime+dev');

    const { choices, prompts } = await resolve('quick');

    assert.deepEqual(choices, { deep: false, includeDev: true });
    assert.equal(prompts.length, 1);
    assert.deepEqual(prompts[0]!.options.map((option) => option.value), ['quick', 'deep']);
  });

  test('asks only dependency scope when depth is explicitly quick', async () => {
    __settings.set('analysis.verifyMode', 'quick');
    __settings.set('analysis.dependencyScope', 'ask');

    const { choices, prompts } = await resolve('runtime+dev');

    assert.deepEqual(choices, { deep: false, includeDev: true });
    assert.equal(prompts.length, 1);
    assert.deepEqual(prompts[0]!.options.map((option) => option.value), ['runtime+dev', 'runtime']);
  });

  test('asks only dependency scope when depth is explicitly deep', async () => {
    __settings.set('analysis.verifyMode', 'deep');
    __settings.set('analysis.dependencyScope', 'ask');

    const { choices, prompts } = await resolve('runtime');

    assert.deepEqual(choices, { deep: true, includeDev: false });
    assert.equal(prompts.length, 1);
    assert.deepEqual(prompts[0]!.options.map((option) => option.value), ['runtime+dev', 'runtime']);
  });

  test('returns explicit settings without prompting', async () => {
    __settings.set('analysis.verifyMode', 'deep');
    __settings.set('analysis.dependencyScope', 'runtime');

    let prompted = false;
    const choices = await resolveScanChoices(config(), async () => {
      prompted = true;
      return 'quick';
    });

    assert.deepEqual(choices, { deep: true, includeDev: false });
    assert.equal(prompted, false);
  });

  test('honours legacy includeDev when dependencyScope was never explicitly configured', async () => {
    __settings.set('analysis.verifyMode', 'quick');
    __settings.set('analysis.includeDev', false);

    const choices = await resolveScanChoices(config(true), async () => {
      throw new Error('did not expect a prompt');
    });

    assert.deepEqual(choices, { deep: false, includeDev: false });
  });

  test('an empty answer cancels without choosing defaults', async () => {
    __settings.set('analysis.verifyMode', 'ask');
    __settings.set('analysis.dependencyScope', 'ask');

    const { choices, prompts } = await resolve('');

    assert.equal(choices, undefined);
    assert.equal(prompts.length, 1);
  });
});
