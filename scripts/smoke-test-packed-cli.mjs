#!/usr/bin/env node
// Builds the real npm artifact with `npm pack`, installs *that tarball* into a
// clean temporary directory, and exercises the installed `drift` binary from
// there — never importing anything from this source tree. This is the only
// check in the repo that would catch a bin path typo, a missing entry in
// `files`, an accidentally-devDependency-only runtime import, or an ESM
// resolution error that only appears once the package is actually installed.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

function log(msg) {
  console.log(`[smoke] ${msg}`);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return result;
}

function assert(cond, message) {
  if (!cond) {
    throw new Error(`smoke test failed: ${message}`);
  }
}

let workdir;
let tarballAbsPath;
try {
  log('npm pack (root package)');
  const packOut = execFileSync('npm', ['pack', '--json', '--pack-destination', tmpdir()], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const [{ filename }] = JSON.parse(packOut);
  tarballAbsPath = join(tmpdir(), filename);
  assert(existsSync(tarballAbsPath), `tarball ${tarballAbsPath} was not created`);
  log(`packed ${filename}`);

  workdir = mkdtempSync(join(tmpdir(), 'drift-smoke-'));
  log(`installing into clean directory ${workdir}`);
  execFileSync('npm', ['init', '-y', '--silent'], { cwd: workdir, stdio: 'ignore' });
  execFileSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', tarballAbsPath], {
    cwd: workdir,
    stdio: 'inherit',
  });

  const bin = join(workdir, 'node_modules', '.bin', 'drift');
  assert(existsSync(bin), `installed binary not found at ${bin}`);

  log('drift --version');
  const version = run(bin, ['--version'], { cwd: workdir });
  assert(version.status === 0, `--version exited ${version.status}: ${version.stderr}`);
  assert(version.stdout.trim() === pkg.version, `--version printed "${version.stdout.trim()}", expected "${pkg.version}"`);

  log('drift --help');
  const help = run(bin, ['--help'], { cwd: workdir });
  assert(help.status === 0, `--help exited ${help.status}: ${help.stderr}`);
  assert(/drift analyze/.test(help.stdout), '--help output missing usage text');

  // No git remote / no token here: this must fail with Drift's own, readable
  // error — not an import error, not a stack trace, not a hang.
  const emptyDir = mkdtempSync(join(tmpdir(), 'drift-smoke-empty-'));
  const env = { ...process.env };
  delete env.GITHUB_TOKEN;

  log('drift analyze (no token, clean install, non-repo cwd) — expect a clean, deterministic failure');
  const analyzeNoToken = run(bin, ['analyze'], { cwd: emptyDir, env });
  assert(analyzeNoToken.status === 1, `analyze without a token should exit 1, got ${analyzeNoToken.status}`);
  assert(
    /GitHub token is required/.test(analyzeNoToken.stderr) || /GitHub token is required/.test(analyzeNoToken.stdout),
    `analyze without a token printed an unexpected error:\n${analyzeNoToken.stderr}\n${analyzeNoToken.stdout}`,
  );
  assert(
    !/Cannot find module|ERR_MODULE_NOT_FOUND|ERR_REQUIRE_ESM|is not a function/.test(
      analyzeNoToken.stderr + analyzeNoToken.stdout,
    ),
    `analyze without a token hit a runtime/import error instead of Drift's own error path:\n${analyzeNoToken.stderr}`,
  );

  log('drift fix (no token) — expect the same deterministic failure, no worktree created');
  const fixNoToken = run(bin, ['fix'], { cwd: emptyDir, env });
  assert(fixNoToken.status === 1, `fix without a token should exit 1, got ${fixNoToken.status}`);
  assert(
    /GitHub token is required/.test(fixNoToken.stderr) || /GitHub token is required/.test(fixNoToken.stdout),
    `fix without a token printed an unexpected error:\n${fixNoToken.stderr}\n${fixNoToken.stdout}`,
  );

  log('drift pr (no token, no git repo) — expect a clean failure, not a crash');
  const prNoToken = run(bin, ['pr'], { cwd: emptyDir, env });
  assert(prNoToken.status === 1, `pr with no git repo should exit 1, got ${prNoToken.status}`);
  assert(
    !/Cannot find module|ERR_MODULE_NOT_FOUND|ERR_REQUIRE_ESM/.test(prNoToken.stderr + prNoToken.stdout),
    `pr hit a runtime/import error instead of Drift's own error path:\n${prNoToken.stderr}`,
  );
  rmSync(emptyDir, { recursive: true, force: true });

  // If a real token is available (e.g. CI's GITHUB_TOKEN), also exercise the
  // full analyze pipeline against a real repository, from the packed install,
  // to prove the shipped artifact — not the source tree — can actually talk
  // to the network dependencies it bundled.
  if (process.env.GITHUB_TOKEN) {
    log('drift analyze (real token, real repo) — full pipeline from the packed artifact');
    const realAnalyze = run(
      bin,
      ['analyze', '--dir', repoRoot, '--repo', 'trydrift/drift', '--before', 'HEAD~1', '--after', 'HEAD'],
      { cwd: repoRoot, env: process.env },
    );
    assert(
      realAnalyze.status === 0,
      `analyze against a real repo with a real token should exit 0, got ${realAnalyze.status}:\n${realAnalyze.stderr}`,
    );
    assert(
      !/Cannot find module|ERR_MODULE_NOT_FOUND|ERR_REQUIRE_ESM/.test(realAnalyze.stderr + realAnalyze.stdout),
      `analyze hit a runtime/import error:\n${realAnalyze.stderr}`,
    );
  } else {
    log('GITHUB_TOKEN not set — skipping the live analyze-against-a-real-repo check (still ran the offline paths above)');
  }

  log('all packaged-CLI smoke checks passed');
} finally {
  if (workdir) rmSync(workdir, { recursive: true, force: true });
  if (tarballAbsPath) rmSync(tarballAbsPath, { force: true });
}
