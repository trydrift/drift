#!/usr/bin/env node
// Single source of truth for "is the shipped Action bundle trustworthy?",
// shared by ci.yml, release.yml, and `npm run release:check` so the three
// never drift apart. Rebuilds action/index.cjs and checks:
//   1. the committed bundle is byte-for-byte what the source produces now
//   2. it runs with node_modules absent (nothing was left unbundled)
//   3. the optional Anthropic SDK is statically bundled, not just referenced
//      (llm.enabled: true has no npm install to fall back on in a real Action run)
//   4. it runs under Node 24 — the runtime `action.yml` declares, and not the
//      one CI otherwise uses
import { execFileSync, spawnSync } from 'node:child_process';
import { renameSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function log(msg) {
  console.log(`[verify-action-bundle] ${msg}`);
}

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

log('rebuilding action/index.cjs');
execFileSync('npm', ['run', 'build:action'], { cwd: repoRoot, stdio: 'inherit' });

log('checking the committed bundle is up to date');
const diff = spawnSync('git', ['diff', '--stat', '--exit-code', '--', 'action/'], { cwd: repoRoot, encoding: 'utf8' });
if (diff.status !== 0) {
  console.error(diff.stdout);
  fail('action/index.cjs is stale — run `npm run build:action` and commit the result.');
}

const nodeModules = `${repoRoot}/node_modules`;
const hidden = `${repoRoot}/node_modules.hidden`;
let hiddenAway = false;

// Force the plain-text logger format regardless of whether this script is
// itself running inside a real Actions job — otherwise, when it is (as in
// CI), the spawned bundle inherits GITHUB_ACTIONS=true and its logger emits
// `::error::` workflow commands instead of the `drift:error` marker checked
// below, making this check fail in CI while passing everywhere else.
const childEnv = { ...process.env, GITHUB_ACTIONS: 'false' };

try {
  log('checking the bundle is self-contained (node_modules removed)');
  if (existsSync(nodeModules)) {
    renameSync(nodeModules, hidden);
    hiddenAway = true;
  }

  const result = spawnSync('node', ['action/index.cjs'], { cwd: repoRoot, encoding: 'utf8', env: childEnv });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

  if (/Cannot find module|ERR_MODULE_NOT_FOUND|ERR_REQUIRE_ESM/.test(output)) {
    console.error(output);
    fail('the action bundle is not self-contained — something was left unbundled.');
  }
  if (!/drift:error/.test(output)) {
    console.error(output);
    fail("the action bundle did not reach Drift's own error path (module resolution likely failed before user code ran).");
  }
} finally {
  if (hiddenAway) renameSync(hidden, nodeModules);
}

log('checking the Anthropic SDK is bundled, not just referenced');
const bundle = readFileSync(`${repoRoot}/action/index.cjs`, 'utf8');
if (!bundle.includes('AnthropicError')) {
  fail(
    '@anthropic-ai/sdk is not bundled into action/index.cjs — llm.enabled: true would silently fall back in the Action, which has no node_modules to resolve it from.',
  );
}

/**
 * Run the bundle under the runtime GitHub will actually use.
 *
 * `action.yml` declares `using: node24`; the CI matrix is Node 22. A bundle
 * that parses and runs under 22 is not evidence it runs under 24 — one changed
 * runtime behavior, reaching the bundle through any dependency, fails at run time
 * in a user's repository on their first dependency change, where nothing we
 * run here would ever have seen it.
 *
 * Reaching Drift's own error path is the success condition, the same as the
 * self-containment check above: with no token configured the Action is
 * supposed to stop and say so, and getting that far proves the whole bundle
 * loaded and evaluated.
 */
function findNode24() {
  if (process.env.DRIFT_NODE24) return process.env.DRIFT_NODE24;
  if (process.versions.node.startsWith('24.')) return process.execPath;

  const candidates = ['node24'];
  const nvm = `${process.env.HOME ?? ''}/.nvm/versions/node`;
  try {
    for (const dir of readdirSync(nvm)) {
      if (dir.startsWith('v24.')) candidates.push(`${nvm}/${dir}/bin/node`);
    }
  } catch {
    // No nvm on this machine; the PATH candidate is the only chance.
  }

  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0 && (probe.stdout ?? '').trim().startsWith('v24.')) return candidate;
  }
  return null;
}

const node24 = findNode24();
if (!node24) {
  // Loud, not skipped. A gate that quietly passes when it could not run reads
  // as a green tick, which is worse than not having the gate at all.
  fail(
    'no Node 24 runtime found, so the bundle could not be checked against the runtime action.yml ' +
      'declares. Install Node 24 (`nvm install 24`), or set DRIFT_NODE24 to its binary. In CI, add ' +
      'an actions/setup-node step with node-version: 24.',
  );
}

log(`checking the bundle runs on Node 24 (${node24})`);
const onNode24 = spawnSync(node24, ['action/index.cjs'], { cwd: repoRoot, encoding: 'utf8', env: childEnv });
const node24Output = `${onNode24.stdout ?? ''}${onNode24.stderr ?? ''}`;

if (/SyntaxError|ERR_UNSUPPORTED|is not a function|Unexpected token/.test(node24Output)) {
  console.error(node24Output);
  fail('the action bundle does not run on Node 24, which is the runtime action.yml declares.');
}
if (!/drift:error/.test(node24Output)) {
  console.error(node24Output);
  fail("the action bundle did not reach Drift's own error path under Node 24.");
}

log('action bundle verified: current, self-contained, bundles the Anthropic SDK, and runs on Node 24');
