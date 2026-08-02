import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  contributes: {
    views: Record<string, { id: string }[]>;
    keybindings: { command: string }[];
    walkthroughs?: { id: string; steps: unknown[] }[];
    configuration: { properties: Record<string, unknown> };
  };
};

describe('extension package contributions', () => {
  test('keeps dependency results visible outside the webview transcript', () => {
    assert.ok((pkg.contributes.views.drift ?? []).some((view) => view.id === 'drift.dependencies'));
  });

  test('binds the high-traffic Drift commands', () => {
    const commands = new Set(pkg.contributes.keybindings.map((binding) => binding.command));
    for (const command of [
      'drift.analyze',
      'drift.fixAll',
      'drift.reviewChanges',
      'drift.keepAllChanges',
      'drift.undoAllChanges',
      'drift.nextChange',
    ]) {
      assert.ok(commands.has(command), `${command} has a keybinding`);
    }
  });

  test('contributes the first-run walkthrough', () => {
    const walkthrough = pkg.contributes.walkthroughs?.find((entry) => entry.id === 'drift.getStarted');
    assert.ok(walkthrough);
    assert.equal(walkthrough!.steps.length, 5);
  });

  test('removes the deprecated single effort setting from Settings UI', () => {
    assert.equal('drift.session.effort' in pkg.contributes.configuration.properties, false);
    assert.ok('drift.agent.efforts' in pkg.contributes.configuration.properties);
  });
});

describe('extension package exclusions', () => {
  const ignore = readFileSync('.vscodeignore', 'utf8');

  test('ships the bundle instead of raw TypeScript and dev-only files', () => {
    for (const pattern of ['src/**', 'test/**', 'node_modules/**', '.git/**', 'esbuild.mjs', 'tsconfig.json']) {
      assert.match(ignore, new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });
});
