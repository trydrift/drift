import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';

const workflowPath = new URL('../.github/workflows/release.yml', import.meta.url);
const source = readFileSync(workflowPath, 'utf8');
const workflow = parse(source);

test('release validation and publishing have separate least-privilege jobs', () => {
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.jobs.validate.permissions, { contents: 'read' });
  assert.equal(workflow.jobs.publish.needs, 'validate');
  assert.deepEqual(workflow.jobs.publish.permissions, {
    contents: 'write',
    'id-token': 'write',
  });
  assert.equal((source.match(/^\s+id-token: write$/gm) ?? []).length, 1);
  assert.equal((source.match(/^\s+contents: write$/gm) ?? []).length, 1);
  assert.doesNotMatch(source, /if:\s*always\(\)/);
});

test('release commit must already be contained in main before validation or publishing', () => {
  const validateRuns = workflow.jobs.validate.steps.map((step) => step.run ?? '').join('\n');
  assert.match(validateRuns, /git fetch --no-tags origin \+refs\/heads\/main:refs\/remotes\/origin\/main/);
  assert.match(validateRuns, /git merge-base --is-ancestor "\$\{GITHUB_SHA\}\^\{commit\}" origin\/main/);
});

test('validation uploads the exact artifacts that publishing downloads', () => {
  const upload = workflow.jobs.validate.steps.find((step) =>
    step.uses?.startsWith('actions/upload-artifact@'),
  );
  const download = workflow.jobs.publish.steps.find((step) =>
    step.uses?.startsWith('actions/download-artifact@'),
  );

  assert.equal(
    upload?.uses,
    'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
  );
  assert.equal(
    download?.uses,
    'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
  );
  assert.equal(upload?.with?.name, 'release-artifacts');
  assert.equal(download?.with?.name, 'release-artifacts');

  const validateRuns = workflow.jobs.validate.steps.map((step) => step.run ?? '').join('\n');
  assert.match(validateRuns, /npm pack --pack-destination artifacts/);
  assert.match(validateRuns, /npm run smoke:packed-cli -- "\$CLI_TARBALL"/);
  assert.match(validateRuns, /cp extension\/drift\.vsix artifacts\/drift\.vsix/);
});

test('privileged publishing neither checks out nor executes repository validation', () => {
  const publishSteps = workflow.jobs.publish.steps;
  const publishRuns = publishSteps.map((step) => step.run ?? '').join('\n');

  assert.equal(
    publishSteps.some((step) => step.uses?.startsWith('actions/checkout@')),
    false,
  );
  assert.doesNotMatch(publishRuns, /\bnpm (?:ci|test|run|pack)\b/);
  assert.doesNotMatch(publishRuns, /scripts\//);
  assert.match(publishRuns, /npm publish "\$\{\{ steps\.artifacts\.outputs\.cli_tarball \}\}"/);
  // The VSIX is attached to the release, not published from here — see the
  // long comment in `release.yml` where the `vsce` step used to be.
  assert.match(publishRuns, /gh release create[\s\S]*steps\.artifacts\.outputs\.vsix/);
});

/**
 * `vsce publish --oidc` was in this workflow for months and never worked. The
 * flag is documented on `vscode-vsce`'s main branch but has not shipped in any
 * release — 3.9.1, 3.9.2 and the 3.9.3 prereleases all answer `error: unknown
 * option '--oidc'` — so the step could only ever fail.
 *
 * What made that fatal instead of merely broken is where it sat: after
 * `npm publish`. npm versions are immutable, so the first tag would have
 * published `@usedrift/cli` and then died, and that version number could never
 * be used again.
 *
 * This is checked rather than remembered because the failure is invisible until
 * a real tag, and a real tag is the one run that cannot be repeated.
 */
test('the privileged job never publishes to a second registry after npm', () => {
  const publishRuns = workflow.jobs.publish.steps.map((step) => step.run ?? '').join('\n');

  assert.doesNotMatch(
    publishRuns,
    /--oidc\b/,
    '`vsce --oidc` does not exist in any released version; check `vsce publish --help`, not the README',
  );

  const lines = publishRuns.split('\n');
  const npmPublishAt = lines.findIndex((line) => /\bnpm publish\b/.test(line));
  assert.ok(npmPublishAt >= 0, 'the CLI is published from this job');

  const laterRegistryPublish = lines
    .slice(npmPublishAt + 1)
    .find((line) => /\bvsce\b.*\bpublish\b|\bnpm publish\b/.test(line));
  assert.equal(
    laterRegistryPublish,
    undefined,
    `an immutable publish runs after npm publish and could strand it: ${laterRegistryPublish}`,
  );
});
