import { readFile, writeFile } from 'node:fs/promises';

async function edit(path, transform) {
  const before = await readFile(path, 'utf8');
  const after = transform(before);
  if (after === before) throw new Error(`${path}: transform made no changes`);
  await writeFile(path, after, 'utf8');
}

function replaceOnce(source, from, to, label) {
  const first = source.indexOf(from);
  if (first < 0) throw new Error(`${label}: expected text not found`);
  if (source.indexOf(from, first + from.length) >= 0) throw new Error(`${label}: expected text is not unique`);
  return source.slice(0, first) + to + source.slice(first + from.length);
}

await edit('src/cli.ts', (source) => {
  source = replaceOnce(
    source,
    '\nEnvironment:\n',
    '\nRun diagnostics for `analyze`, `outdated`, `fix`, and `pr`:\n' +
      '  --record-run                 Write a repo-local diagnostic log for this run.\n' +
      '                               Off by default.\n' +
      '  --no-record-run              Do not record this run, even when\n' +
      '                               DRIFT_RECORD_RUNS is enabled.\n\n' +
      'Environment:\n',
    'CLI diagnostics help',
  );

  source = replaceOnce(
    source,
    '  DRIFT_COPILOT_TOKEN         User-scoped token for the Copilot agent API\n' +
      '  DRIFT_TELEMETRY_DISABLED    1/true disables telemetry even if configured\n',
    '  DRIFT_COPILOT_TOKEN         User-scoped token for the Copilot agent API\n' +
      '  DRIFT_RECORD_RUNS           1/true records repo-local diagnostic logs for\n' +
      '                              repository commands. Default: disabled\n' +
      '  DRIFT_TELEMETRY_DISABLED    1/true disables telemetry even if configured\n',
    'CLI diagnostics environment help',
  );

  source = replaceOnce(
    source,
    "/** Commands that operate on a repository, and so get a repo-local run log. */\nconst REPO_COMMANDS = new Set(['analyze', 'analyse', 'outdated', 'fix', 'pr']);\n\nasync function gitHeadShort",
    "/** Commands eligible for opt-in repo-local run logging. */\nconst REPO_COMMANDS = new Set(['analyze', 'analyse', 'outdated', 'fix', 'pr']);\n\n/**\n * Run recording is a local diagnostic preference, not repository policy.\n * Explicit CLI flags win over the machine-level environment opt-in.\n */\nexport function shouldRecordRun(\n  flags: Readonly<Record<string, string | boolean>>,\n  env: NodeJS.ProcessEnv = process.env,\n): boolean {\n  if (flags['no-record-run'] === true) return false;\n  if (flags['record-run'] === true) return true;\n  const value = env.DRIFT_RECORD_RUNS?.trim().toLowerCase();\n  return value === '1' || value === 'true';\n}\n\nasync function gitHeadShort",
    'CLI recording policy',
  );

  source = replaceOnce(
    source,
    '  const runLog = repoRoot\n    ? startRunLog({',
    '  const runLog = repoRoot && shouldRecordRun(flags)\n    ? startRunLog({',
    'CLI run log gate',
  );

  return source;
});

await edit('extension/src/extension.ts', (source) => {
  source = replaceOnce(
    source,
    "import { redactText, startRunLog, withSpan, type RunLogHandle } from '../../src/util/diagnostics.js';\n",
    "import { redactText, startRunLog, withSpan, type RunLogHandle } from '../../src/util/diagnostics.js';\n" +
      "import { shouldRecordRuns } from './run-recording.js';\n",
    'extension recording import',
  );
  source = replaceOnce(
    source,
    '  if (!repoRoot) return undefined;\n  return startRunLog({ command: `vscode: ${command}`, mode, repoRoot, driftVersion: extensionVersion });',
    '  if (!repoRoot || !shouldRecordRuns()) return undefined;\n  return startRunLog({ command: `vscode: ${command}`, mode, repoRoot, driftVersion: extensionVersion });',
    'extension run log gate',
  );
  source = source.replace(
    ' * Start a fresh, repo-local run log for one Drift operation (an analyze, a\n',
    ' * When run recording is enabled, start a fresh repo-local log for one Drift operation (an analyze, a\n',
  );
  return source;
});

await edit('extension/src/run-diagnostics.ts', (source) => {
  source = replaceOnce(
    source,
    "import { redactText, startRunLog, withSpan } from '../../src/util/diagnostics.js';\n",
    "import { redactText, startRunLog, withSpan } from '../../src/util/diagnostics.js';\n" +
      "import { shouldRecordRuns } from './run-recording.js';\n",
    'panel diagnostics recording import',
  );
  source = replaceOnce(
    source,
    '): Promise<T> {\n  const log = startRunLog({',
    '): Promise<T> {\n  if (!shouldRecordRuns()) return work();\n\n  const log = startRunLog({',
    'panel diagnostics run log gate',
  );
  return source;
});

await writeFile(
  'extension/src/run-recording.ts',
  "import * as vscode from 'vscode';\n\n" +
    "/** VS Code user/workspace preference for repo-local diagnostic run artifacts. */\n" +
    "export function shouldRecordRuns(): boolean {\n" +
    "  return vscode.workspace.getConfiguration('drift').get<boolean>('diagnostics.recordRuns', false);\n" +
    "}\n",
  'utf8',
);

await edit('extension/package.json', (source) => {
  const setting =
    '        "drift.diagnostics.recordRuns": {\n' +
    '          "type": "boolean",\n' +
    '          "default": false,\n' +
    '          "markdownDescription": "Record a repo-local diagnostic log for each Drift operation. **Off by default.** Enable this when diagnosing performance or behavior. Logs are secret-redacted, but can include package names, file paths, command metadata, timings, cache activity, and subprocess summaries.",\n' +
    '          "order": 89\n' +
    '        },\n';
  return replaceOnce(source, '        "drift.logLevel": {\n', setting + '        "drift.logLevel": {\n', 'VS Code recording setting');
});

await edit('extension/test/run-diagnostics.test.ts', (source) => {
  source = replaceOnce(
    source,
    "import { test, describe } from 'node:test';\n",
    "import { test, describe, beforeEach } from 'node:test';\n",
    'extension diagnostics test hook import',
  );
  source = replaceOnce(
    source,
    "import { resolveGitDir, startSpan } from '../../src/util/diagnostics.js';\n",
    "import { resolveGitDir, startSpan } from '../../src/util/diagnostics.js';\n" +
      "import { __settings } from './vscode-stub.js';\n",
    'extension diagnostics settings import',
  );
  source = replaceOnce(
    source,
    "  const names = (await readdir(dir)).filter((name) => name.endsWith('.log')).sort();",
    "  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith('.log')).sort();",
    'extension diagnostics missing-dir handling',
  );
  source = replaceOnce(
    source,
    "describe('runRepoDiagnostic', () => {\n",
    "beforeEach(() => {\n  __settings.clear();\n  __settings.set('diagnostics.recordRuns', true);\n});\n\ndescribe('runRepoDiagnostic', () => {\n" +
      "  test('does not record runs by default', async () => {\n" +
      "    await withGitRepo(async (root) => {\n" +
      "      __settings.clear();\n" +
      "      let ran = false;\n" +
      "      await runRepoDiagnostic({ command: 'test', mode: 'quick', repoRoot: root, spanName: 'scan' }, async () => {\n" +
      "        ran = true;\n" +
      "      });\n" +
      "      assert.equal(ran, true);\n" +
      "      assert.deepEqual(await completedLogs(root), []);\n" +
      "    });\n" +
      "  });\n\n",
    'extension diagnostics default-off test',
  );
  return source;
});

await writeFile(
  'test/cli-run-recording.test.ts',
  "import { test } from 'node:test';\n" +
    "import assert from 'node:assert/strict';\n" +
    "import { shouldRecordRun } from '../dist/cli.js';\n\n" +
    "test('CLI run recording is disabled by default', () => {\n" +
    "  assert.equal(shouldRecordRun({}, {}), false);\n" +
    "});\n\n" +
    "test('CLI --record-run opts in', () => {\n" +
    "  assert.equal(shouldRecordRun({ 'record-run': true }, {}), true);\n" +
    "});\n\n" +
    "test('DRIFT_RECORD_RUNS enables persistent machine-level recording', () => {\n" +
    "  assert.equal(shouldRecordRun({}, { DRIFT_RECORD_RUNS: '1' }), true);\n" +
    "  assert.equal(shouldRecordRun({}, { DRIFT_RECORD_RUNS: 'true' }), true);\n" +
    "});\n\n" +
    "test('CLI --no-record-run overrides the environment opt-in', () => {\n" +
    "  assert.equal(shouldRecordRun({ 'no-record-run': true }, { DRIFT_RECORD_RUNS: '1' }), false);\n" +
    "});\n",
  'utf8',
);

await edit('src/util/diagnostics.ts', (source) => {
  source = replaceOnce(
    source,
    '/**\n * Always-on, repo-local diagnostic run logging.\n *\n * `DRIFT_PROFILE` (see `profile.ts`) is opt-in and detailed — a JSON dump for\n * `scripts/profile-report.mjs`. This is the opposite: on by default, plain\n * text, and written so that handing the file to a human or an AI agent is\n * enough to answer "why did this run take 15 minutes instead of 30 seconds",\n * without anyone having to know a flag exists first.\n',
    '/**\n * Repo-local diagnostic run logging.\n *\n * Recording policy lives at the CLI/extension boundary and is opt-in by\n * default. This module is the mechanism: once a surface starts a run, it\n * captures enough plain-text timing and attribution data to answer questions\n * such as "why did this run take 15 minutes instead of 30 seconds?".\n * `DRIFT_PROFILE` (see `profile.ts`) remains a separate, more detailed JSON\n * profiler for `scripts/profile-report.mjs`.\n',
    'diagnostics module policy comment',
  );
  source = source.replace('so always-on diagnostics do not turn into a stream', 'so diagnostics do not turn into a stream');
  return source;
});

console.log('Applied opt-in run diagnostics patch.');
