/**
 * Headless test of the extension's UI logic.
 *
 * Runs the real analysis against a real repository, then drives the real
 * diagnostics, state machine, and report renderer over the result —
 * with `vscode` swapped for a stub. Everything except the editor chrome is the
 * code that actually ships.
 *
 * Writes the rendered report to `dist/report-preview.html` so the styling can
 * be opened and looked at, rather than merely asserted about.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { analyzeRepository } from '../../src/analysis.js';
import { LocalGitProvider, inspectLocalRepo } from '../../src/repo/local-git.js';
import { DriftConfigSchema } from '../../src/config/schema.js';
import { createLogger } from '../../src/util/logger.js';
import { DriftState } from '../src/state.js';
import { DriftDiagnostics } from '../src/ui/diagnostics.js';
import { CLI_AGENT_SPECS, which } from '../src/agents/cli.js';
import { parseFileBlocks, saysNoChanges, buildFixPrompt } from '../src/agents/types.js';
import { workspace } from './vscode-stub.js';

const REPO = process.env.DRIFT_TEST_REPO;
if (!REPO) {
  console.error('Set DRIFT_TEST_REPO to a git checkout with a dependency change.');
  process.exit(1);
}

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function main(): Promise<void> {
  console.log('=== 1. analysis (no credentials) ===');

  const info = await inspectLocalRepo(REPO);
  if (!info) throw new Error(`${REPO} is not a git repository`);
  console.log(`repo ${info.slug ?? '(no remote)'} @ ${info.headSha.slice(0, 7)}`);

  const range = { before: info.parentSha!, after: info.headSha };
  const result = await analyzeRepository({
    repo: {
      owner: info.slug?.split('/')[0] ?? 'local',
      repo: info.slug?.split('/')[1] ?? 'workspace',
      baseBranch: info.branch,
      beforeSha: range.before,
      afterSha: range.after,
      workspace: REPO,
    },
    config: DriftConfigSchema.parse({}),
    logger: createLogger('error'),
    provider: new LocalGitProvider(REPO, range),
    workspace: REPO,
  });

  const plan = result.plan;
  check('analysis produced a plan', plan !== null, result.summary);
  if (!plan) process.exit(1);

  check('found breaking changes', plan.breakingChanges.length > 0, `${plan.breakingChanges.length}`);
  check('located impact sites', plan.impactSites.length > 0, `${plan.impactSites.length}`);
  check('planned separated commits', plan.commits.length > 0, `${plan.commits.length}`);
  check(
    'every finding cites evidence',
    plan.breakingChanges.every((c) => c.citations.length > 0),
  );

  console.log('\n=== 2. state machine ===');

  workspace.workspaceFolders = [{ uri: { fsPath: REPO } }];

  const state = new DriftState();
  state.setRepo(info, REPO);

  const seen: string[] = [];
  state.onDidChange((s) => seen.push(s.kind));

  state.set({ kind: 'analysing', detail: 'working' });
  state.set({ kind: 'findings', plan, at: Date.now() });

  check('state events fired', seen.length === 2, seen.join(' → '));
  check('plan is reachable from state', state.plan?.id === plan.id);
  check('busy flag clears after analysis', !state.isBusy);

  console.log('\n=== 3. diagnostics ===');

  const diagnostics = new DriftDiagnostics(state);
  diagnostics.render();

  const collection = (
    diagnostics as unknown as { collection: { __store: Map<string, unknown[]> } }
  ).collection;
  const flaggedFiles = collection.__store.size;
  const totalMarkers = [...collection.__store.values()].reduce((n, v) => n + v.length, 0);

  check('flagged files in the Problems panel', flaggedFiles > 0, `${flaggedFiles} file(s)`);
  check('marker count matches impact sites', totalMarkers === plan.impactSites.length, `${totalMarkers}`);

  console.log('\n=== 4. report rendering ===');

  // renderHtml is module-private; exercise it the way the panel does.
  const { __renderForTest } = await import('../src/ui/report.js');
  const html = __renderForTest(state);

  check('report renders', html.length > 1000, `${html.length} bytes`);
  check('has a strict CSP', html.includes("default-src 'none'"));
  check('uses theme variables', html.includes('--vscode-editor-background'));
  check('no external resource loads', !/https?:\/\/[^"']*\.(js|css|png|woff)/i.test(html));
  check('lists a breaking change', html.includes(escapeForCheck(plan.breakingChanges[0]!.summary)));
  check('renders evidence', html.includes('Evidence'));
  check('has a fix button', html.includes('drift.fixAll'));

  // Plain paths, not import.meta: the harness bundles as CommonJS (see
  // test/build.mjs for why) where import.meta is unavailable.
  mkdirSync('dist', { recursive: true });
  const out = 'dist/report-preview.html';
  writeFileSync(out, html);
  console.log(`  wrote ${resolve(out)}`);

  console.log('\n=== 5. agent plumbing ===');

  const prompt = buildFixPrompt({
    plan,
    commit: plan.commits[0]!,
    workspaceRoot: REPO,
    files: [],
  });
  check('prompt carries evidence', prompt.includes('Evidence'));
  check('prompt forbids weakening tests', /do not weaken/i.test(prompt));
  check('prompt forbids version changes', /do not.*change dependency versions/is.test(prompt));
  check('prompt includes impact locations', prompt.includes('Known locations'));

  const parsed = parseFileBlocks(
    ['=== DRIFT FILE: src/a.ts', 'const x = 1;', 'const y = 2;', '=== DRIFT END ==='].join('\n'),
  );
  check('parses whole-file blocks', parsed.length === 1 && parsed[0]!.path === 'src/a.ts');
  check('preserves file content', parsed[0]!.content === 'const x = 1;\nconst y = 2;');

  const fenced = parseFileBlocks(
    ['=== DRIFT FILE: src/b.ts', '```ts', 'const z = 3;', '```', '=== DRIFT END ==='].join('\n'),
  );
  check('strips an accidental markdown fence', fenced[0]!.content === 'const z = 3;');
  check('recognises the no-change reply', saysNoChanges('NO CHANGES NEEDED'));

  console.log('\n=== 7. agent discovery on this machine ===');

  for (const spec of CLI_AGENT_SPECS) {
    const found = await which(spec.command);
    console.log(`  ${found ? '✓' : '·'} ${spec.label.padEnd(14)} ${found ?? 'not installed'}`);
  }

  const ollama = await fetch('http://localhost:11434/api/tags', {
    signal: AbortSignal.timeout(1500),
  })
    .then((r) => r.ok)
    .catch(() => false);
  console.log(`  ${ollama ? '✓' : '·'} ${'Ollama'.padEnd(14)} ${ollama ? 'running' : 'not running'}`);

  console.log(`\n${failures === 0 ? '*** ALL CHECKS PASSED ***' : `*** ${failures} CHECK(S) FAILED ***`}`);
  process.exit(failures === 0 ? 0 : 1);
}

function escapeForCheck(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
