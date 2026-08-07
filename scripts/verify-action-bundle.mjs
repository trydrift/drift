#!/usr/bin/env node
// Single source of truth for "is the shipped Action bundle trustworthy?",
// shared by ci.yml, release.yml, and `npm run release:check` so the three
// never drift apart. Rebuilds action/index.cjs and checks:
//   1. the committed bundle is byte-for-byte what the source produces now
//   2. it runs with node_modules absent (nothing was left unbundled)
//   3. the optional Anthropic SDK is statically bundled, not just referenced
//      (llm.enabled: true has no npm install to fall back on in a real Action run)
import { execFileSync, spawnSync } from 'node:child_process';
import { renameSync, existsSync, readFileSync } from 'node:fs';
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
try {
  log('checking the bundle is self-contained (node_modules removed)');
  if (existsSync(nodeModules)) {
    renameSync(nodeModules, hidden);
    hiddenAway = true;
  }

  const result = spawnSync('node', ['action/index.cjs'], { cwd: repoRoot, encoding: 'utf8' });
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

log('action bundle verified: current, self-contained, and includes the Anthropic SDK');
