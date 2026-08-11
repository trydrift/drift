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

  // No git remote / no token here. The commands divide on exactly this: the
  // read-only ones must work anyway, and the ones that write must refuse
  // clearly. Either way the failure mode must be Drift's own readable message
  // — never an import error, a stack trace, or a hang.
  const emptyDir = mkdtempSync(join(tmpdir(), 'drift-smoke-empty-'));
  const env = { ...process.env };
  delete env.GITHUB_TOKEN;

  // `analyze` is read-only by construction: it diffs the local checkout and
  // needs no token at all. This assertion used to demand exit 1 and "GitHub
  // token is required", which stopped being true when analyze was made
  // token-free — so the gate had been failing on `main` against behaviour that
  // is not merely acceptable but is the whole "try it with zero permissions"
  // promise. It is asserted the right way round now.
  log('drift analyze (no token, clean install, non-repo cwd) — must succeed; analyze never needs a token');
  const analyzeNoToken = run(bin, ['analyze'], { cwd: emptyDir, env });
  assert(
    analyzeNoToken.status === 0,
    `analyze needs no token and must exit 0, got ${analyzeNoToken.status}:\n${analyzeNoToken.stderr}`,
  );
  assert(
    /No dependency manifest changed/.test(analyzeNoToken.stdout + analyzeNoToken.stderr),
    `analyze should report that nothing changed, got:\n${analyzeNoToken.stdout}\n${analyzeNoToken.stderr}`,
  );
  assert(
    !/Cannot find module|ERR_MODULE_NOT_FOUND|ERR_REQUIRE_ESM|is not a function/.test(
      analyzeNoToken.stderr + analyzeNoToken.stdout,
    ),
    `analyze without a token hit a runtime/import error instead of Drift's own error path:\n${analyzeNoToken.stderr}`,
  );

  // `fix` writes — it pushes a branch and opens a pull request — so it must
  // refuse without credentials, and say why in words a user can act on.
  log('drift fix (no token) — expect a clean refusal, no worktree created');
  const fixNoToken = run(bin, ['fix'], { cwd: emptyDir, env });
  assert(fixNoToken.status === 1, `fix without a token should exit 1, got ${fixNoToken.status}`);
  assert(
    /Signing in to GitHub is required|Could not determine the repository/.test(
      fixNoToken.stderr + fixNoToken.stdout,
    ),
    `fix without a token printed an unexpected error:\n${fixNoToken.stderr}\n${fixNoToken.stdout}`,
  );
  assert(
    !/Cannot find module|ERR_MODULE_NOT_FOUND|ERR_REQUIRE_ESM|is not a function/.test(
      fixNoToken.stderr + fixNoToken.stdout,
    ),
    `fix hit a runtime/import error instead of Drift's own error path:\n${fixNoToken.stderr}`,
  );

  // `outdated` is the other read-only command, and the one a first-time user
  // is most likely to run. It scans the registry, so it is allowed to find
  // nothing here — it is not allowed to demand credentials or crash.
  log('drift outdated (no token, non-repo cwd) — read-only, must not require credentials');
  const outdatedNoToken = run(bin, ['outdated'], { cwd: emptyDir, env });
  assert(
    outdatedNoToken.status === 0,
    `outdated needs no token and must exit 0, got ${outdatedNoToken.status}:\n${outdatedNoToken.stderr}`,
  );
  assert(
    !/Cannot find module|ERR_MODULE_NOT_FOUND|ERR_REQUIRE_ESM|is not a function/.test(
      outdatedNoToken.stderr + outdatedNoToken.stdout,
    ),
    `outdated hit a runtime/import error:\n${outdatedNoToken.stderr}`,
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
