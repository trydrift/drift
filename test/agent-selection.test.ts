import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../dist/config/load.js';
import { DriftConfigSchema, type AgentConfig, type ExplicitAgentProvider } from '../dist/config/schema.js';
import { resolveAgentSelection } from '../dist/agents/selection.js';
import { agentConfigWithLegacyCopilot, credentialsWithLegacyCopilot } from '../dist/agents/compat.js';

const base = (): AgentConfig => DriftConfigSchema.parse({}).remediation.agent;

function runtime(eligibleProviders: ExplicitAgentProvider[], surface: 'cli' | 'action' = 'cli') {
  return { eligibleProviders, interactive: false, surface };
}

describe('agent config normalization', () => {
  test('new provider-neutral config is parsed as repository policy', () => {
    const { config, problems } = parseConfig(
      'remediation:\n  agent:\n    provider: codex\n    model: gpt-5\n    effort: high\n',
      'drift.yml',
    );

    assert.deepEqual(problems, []);
    assert.equal(config.remediation.agent.provider, 'codex');
    assert.equal(config.remediation.agent.model, 'gpt-5');
    assert.equal(config.remediation.agent.effort, 'high');
  });

  test('legacy remediation.model maps to copilot-cloud only when no new agent config exists', () => {
    const legacy = parseConfig('remediation:\n  model: gpt-5-copilot\n', 'drift.yml');
    assert.equal(legacy.config.remediation.agent.provider, 'copilot-cloud');
    assert.equal(legacy.config.remediation.agent.model, 'gpt-5-copilot');
    assert.match(legacy.problems.join('\n'), /remediation\.model.*deprecated/);

    const current = parseConfig(
      'remediation:\n  model: gpt-5-copilot\n  agent:\n    provider: codex\n    model: gpt-5\n',
      'drift.yml',
    );
    assert.equal(current.config.remediation.agent.provider, 'codex');
    assert.equal(current.config.remediation.agent.model, 'gpt-5');
    assert.deepEqual(current.problems, []);
  });
});

describe('agent runtime selection', () => {
  test('explicit invocation override wins', () => {
    const selected = resolveAgentSelection({
      config: base(),
      runtime: runtime(['codex', 'claude']),
      override: { provider: 'codex' },
    });

    assert.equal(selected.provider, 'codex');
    assert.equal(selected.source, 'override');
  });

  test('repository provider wins over local CLI preference', () => {
    const selected = resolveAgentSelection({
      config: { ...base(), provider: 'claude' },
      runtime: runtime(['codex', 'claude']),
      localPreference: { provider: 'codex' },
    });

    assert.equal(selected.provider, 'claude');
    assert.equal(selected.source, 'repository');
  });

  test('saved local preference is never used by the Action', () => {
    const selected = resolveAgentSelection({
      config: base(),
      runtime: runtime(['codex', 'claude'], 'action'),
      localPreference: { provider: 'codex' },
    });

    assert.equal(selected.provider, 'auto');
    assert.equal(selected.source, 'unresolved');
    assert.match(selected.reason, /Multiple AI agents/);
  });

  test('legacy Copilot input is normalized before auto detection', () => {
    const credentials = credentialsWithLegacyCopilot(undefined, 'token');
    const config = agentConfigWithLegacyCopilot(base(), { token: 'token', model: 'copilot-model' });
    const selected = resolveAgentSelection({
      config,
      runtime: { ...runtime(['codex', 'claude', 'copilot-cloud']), credentials },
    });

    assert.equal(selected.provider, 'copilot-cloud');
    assert.equal(selected.source, 'repository');
    assert.equal(selected.config.model, 'copilot-model');
    assert.deepEqual(selected.runtime.credentials?.['copilot-cloud'], { token: 'token' });
  });

  test('unattended auto selects only when exactly one provider is eligible', () => {
    const one = resolveAgentSelection({ config: base(), runtime: runtime(['codex']) });
    assert.equal(one.provider, 'codex');
    assert.equal(one.source, 'single-available');

    const many = resolveAgentSelection({ config: base(), runtime: runtime(['codex', 'claude']) });
    assert.equal(many.provider, 'auto');
    assert.equal(many.source, 'unresolved');
    assert.match(many.reason, /codex, claude/);
  });

  test('unavailable providers fail safely instead of guessing', () => {
    const selected = resolveAgentSelection({ config: base(), runtime: runtime([]) });

    assert.equal(selected.provider, 'auto');
    assert.equal(selected.source, 'unresolved');
    assert.match(selected.reason, /No usable AI agent/);
  });
});
