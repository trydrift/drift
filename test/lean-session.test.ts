import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_CODE_LEAN_SESSION_ARGS, CLI_AGENT_SPECS, CliFixAgent, clearFlagSupportCache } from '../dist/agents/cli.js';
import { DriftConfigSchema } from '../dist/config/schema.js';

/**
 * Drift starts Claude Code with only the tools a code fix uses. The fixed
 * per-call context — system prompt plus every loaded tool definition — was half
 * of all agent input tokens in the benchmark; these tests pin that the launch
 * carries the lean profile, that it can be turned off, and that an older CLI
 * without `--tools` is started exactly as before.
 */

async function fakeClaude(help: string): Promise<{ command: string; argv: () => Promise<string[]>; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'drift-fake-claude-'));
  const command = join(dir, 'claude');
  const log = join(dir, 'argv.json');
  await writeFile(
    command,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--help')) { process.stdout.write(${JSON.stringify(help)}); process.exit(0); }
if (args.includes('--version')) { process.stdout.write('2.1.267 (Claude Code)'); process.exit(0); }
require('fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(args));
process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write('done'); process.exit(0); });
`,
  );
  await chmod(command, 0o755);
  return { command, dir, argv: async () => JSON.parse(await readFile(log, 'utf8')) as string[] };
}

const task = (overrides: Record<string, unknown> = {}) =>
  ({
    plan: { id: 'p', changes: [], breakingChanges: [], evidence: [], impactSites: [], commits: [] },
    commit: { id: 'u', order: 1, message: 'm', body: '', breakingChangeIds: [], files: [], allowedFiles: [], instructions: 'Fix it.', dependsOn: [], dependencyReasons: [], executionLayer: 0, expectedChecks: [], invalidationTriggers: [] },
    workspaceRoot: tmpdir(),
    files: [],
    ...overrides,
  }) as never;

const ctx = { report() {}, signal: new AbortController().signal } as never;
const claudeSpec = CLI_AGENT_SPECS.find((spec) => spec.id === 'claude')!;

describe('lean Claude Code sessions', () => {
  test('the lean profile is the six tools agents used and no skills', () => {
    assert.deepEqual([...CLAUDE_CODE_LEAN_SESSION_ARGS], ['--tools', 'Bash', 'Read', 'Edit', 'Write', 'TaskOutput', 'TaskStop', '--disable-slash-commands']);
    // Off by default: the profile is cheaper and measurably worse, so a
    // caller opts in rather than out. See eval/reports/agent/final-verdict.md.
    assert.equal(DriftConfigSchema.parse({}).remediation.agent.leanSession, false);
  });

  test('a fix session opting in is started with the lean profile when the CLI supports --tools', async () => {
    clearFlagSupportCache();
    const fake = await fakeClaude('  --tools <tools...>\n  --effort <level>\n');
    try {
      const agent = new CliFixAgent({ ...claudeSpec, command: fake.command }, 30_000);
      await agent.run(task({ leanSession: true }), ctx);
      const argv = await fake.argv();
      const at = argv.indexOf('--tools');
      assert.ok(at >= 0);
      assert.deepEqual(argv.slice(at, at + CLAUDE_CODE_LEAN_SESSION_ARGS.length), [...CLAUDE_CODE_LEAN_SESSION_ARGS]);
    } finally {
      await rm(fake.dir, { recursive: true, force: true });
    }
  });

  test('left alone, or on a CLI without --tools, the session starts as before', async () => {
    clearFlagSupportCache();
    const modern = await fakeClaude('  --tools <tools...>\n');
    const old = await fakeClaude('  --model <model>\n');
    try {
      await new CliFixAgent({ ...claudeSpec, command: modern.command }, 30_000).run(task(), ctx);
      assert.equal((await modern.argv()).includes('--tools'), false);
      clearFlagSupportCache();
      await new CliFixAgent({ ...claudeSpec, command: old.command }, 30_000).run(task({ leanSession: true }), ctx);
      assert.equal((await old.argv()).includes('--tools'), false);
      assert.equal((await old.argv()).includes('--disable-slash-commands'), false);
    } finally {
      await rm(modern.dir, { recursive: true, force: true });
      await rm(old.dir, { recursive: true, force: true });
    }
  });
});
