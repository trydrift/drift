import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observedSelection } from './agent-config.ts';

test('records the model and effort the agent itself reported', () => {
  const banner = [
    'OpenAI Codex v0.147.0',
    'workdir: /tmp/x',
    'model: gpt-5.5',
    'provider: openai',
    'approval: never',
    'reasoning effort: medium',
  ];
  assert.deepEqual(observedSelection(banner), { model: 'gpt-5.5', provider: 'openai', effort: 'medium' });
});

test('an agent that reports nothing leaves provenance untouched rather than asserting a requested value', () => {
  assert.deepEqual(observedSelection(['Running Codex for commit 1', '$ codex exec']), {});
});
