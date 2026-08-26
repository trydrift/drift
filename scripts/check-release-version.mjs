#!/usr/bin/env node
/**
 * Verifies that every manifest which carries the product version agrees, and —
 * only when a tag is given — that the tag matches them too. Runs in two modes:
 *
 *   node scripts/check-release-version.mjs
 *     Cross-manifest consistency only. What `release:check` and CI run on
 *     every PR: root package.json, root package-lock.json, extension
 *     package.json, and extension package-lock.json must all report the same
 *     version.
 *
 *   node scripts/check-release-version.mjs --tag v0.1.0
 *     The same check, plus: the tag (with its leading "v" stripped) must
 *     equal that version too. This is what release.yml runs, passing the
 *     pushed tag explicitly rather than reading GITHUB_REF_NAME itself, so
 *     this script has no hidden dependency on being run inside GitHub Actions
 *     and is exercised the same way in its own tests.
 *
 * Never normalizes or edits a version — a mismatch is reported and the
 * process exits non-zero. Fixing it is `scripts/set-version.mjs`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Pure comparison, exported for tests: no filesystem, no process.exit.
 * `tag` is optional; when omitted only cross-manifest consistency is checked.
 */
export function findVersionMismatches({ rootPkg, rootLock, extPkg, extLock, tag }) {
  const readings = [
    ['package.json', rootPkg],
    ['package-lock.json (root package)', rootLock],
    ['extension/package.json', extPkg],
    ['extension/package-lock.json (root package)', extLock],
  ];

  const problems = [];
  const distinct = new Set(readings.map(([, version]) => version));
  if (distinct.size > 1) {
    problems.push(
      'Version mismatch across manifests — every artifact must ship the same version:',
      ...readings.map(([label, version]) => `  ${label}: ${version}`),
    );
  }

  if (tag !== undefined) {
    const tagVersion = tag.replace(/^v/, '');
    const artifactVersion = rootPkg;
    if (tagVersion !== artifactVersion) {
      problems.push(
        `Tag/version mismatch: git tag "${tag}" implies version "${tagVersion}", ` +
          `but the artifact version is "${artifactVersion}".`,
      );
    }
  }

  return problems;
}

function readVersions(root) {
  const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const rootLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).packages[''].version;
  const extPkg = JSON.parse(readFileSync(join(root, 'extension', 'package.json'), 'utf8')).version;
  const extLock = JSON.parse(
    readFileSync(join(root, 'extension', 'package-lock.json'), 'utf8'),
  ).packages[''].version;
  return { rootPkg, rootLock, extPkg, extLock };
}

function parseTag(argv) {
  const flag = argv.find((arg) => arg === '--tag' || arg.startsWith('--tag='));
  if (!flag) return undefined;
  if (flag.includes('=')) return flag.slice('--tag='.length);
  const index = argv.indexOf(flag);
  return argv[index + 1];
}

// Only runs the CLI when this file is executed directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  const tag = parseTag(process.argv.slice(2));
  const versions = readVersions(repoRoot);
  const problems = findVersionMismatches({ ...versions, tag });

  if (problems.length > 0) {
    console.error('check-release-version: FAILED\n');
    for (const line of problems) console.error(line);
    console.error('\nNothing is published while these disagree. Fix every file, do not pick a winner.');
    process.exit(1);
  }

  console.log(
    tag
      ? `check-release-version: all manifests and tag "${tag}" agree on version ${versions.rootPkg}.`
      : `check-release-version: all manifests agree on version ${versions.rootPkg}.`,
  );
}
