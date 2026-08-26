#!/usr/bin/env node
// Everything a maintainer can run locally before tagging a release. Mirrors
// the validation phase of .github/workflows/release.yml step for step, so
// local and CI validation cannot drift apart — both call the same npm
// scripts. This never publishes anything; it only proves the artifacts are
// safe to publish.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const started = Date.now();
const steps = [];

function step(name, fn) {
  steps.push({ name, fn });
}

function sh(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', cwd: repoRoot, ...opts });
}

step('release: cross-manifest version consistency (root/extension package + lockfile)', () =>
  sh('npm', ['run', 'release:version']));
step('root: typecheck', () => sh('npm', ['run', 'typecheck']));
step('root: tests (build + test/*.test.ts)', () => sh('npm', ['test']));
step('root: benchmark review/adjudication integrity', () => sh('npm', ['run', 'eval:review:validate']));
step('root: eval harness test suite', () => sh('npm', ['run', 'eval:test']));
step('root: deterministic evaluation harness', () => sh('npm', ['run', 'eval:deterministic']));
step('action: rebuild, staleness, self-containment, SDK bundling, Node 24 run', () =>
  sh('npm', ['run', 'verify:action-bundle']));

step('extension: install, typecheck, test, build, package', () => {
  sh('npm', ['ci'], { cwd: `${repoRoot}/extension` });
  sh('npm', ['run', 'typecheck'], { cwd: `${repoRoot}/extension` });
  sh('npm', ['test'], { cwd: `${repoRoot}/extension` });
  sh('npm', ['run', 'build'], { cwd: `${repoRoot}/extension` });
  sh('npm', ['run', 'package'], { cwd: `${repoRoot}/extension` });
});

step('cli: npm pack + install into a clean directory + smoke test', () => sh('npm', ['run', 'smoke:packed-cli']));

step('site: production build (catches copy that outlived the feature)', () => {
  sh('npm', ['ci'], { cwd: `${repoRoot}/site` });
  sh('npm', ['run', 'typecheck'], { cwd: `${repoRoot}/site` });
  sh('npm', ['run', 'build'], { cwd: `${repoRoot}/site` });
});

step('workflow: the committed example matches the manifest registry', () =>
  sh('npm', ['run', 'verify:workflow']));

// Identity strings, invented CLI commands, invented extension identifiers, and
// any wording that sells an unchecked result as a pass. The site's build runs
// the equivalent check over the page; this one covers the READMEs and docs.
step('docs: every documented command and identifier exists', () => sh('npm', ['run', 'check:docs']));

let failed = false;
for (const { name, fn } of steps) {
  console.log(`\n\x1b[1m▶ ${name}\x1b[0m`);
  try {
    fn();
  } catch (err) {
    console.error(`\x1b[31m✗ ${name} failed\x1b[0m`);
    console.error(err.message ?? err);
    failed = true;
    break;
  }
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
if (failed) {
  console.error(`\nrelease:check FAILED after ${seconds}s — do not publish.`);
  process.exitCode = 1;
} else {
  console.log(`\nrelease:check passed in ${seconds}s. Safe to tag a release.`);
}
