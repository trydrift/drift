#!/usr/bin/env node
/**
 * Verifies that every manifest which carries the product version agrees, and —
 * only when a tag is given — that the tag matches them too. Runs in two modes:
 *
 *   node scripts/check-release-version.mjs
 *     Cross-manifest consistency only. Root and extension package.json plus
 *     both the top-level and packages[""] version fields in each lockfile must
 *     all report the same exact semantic version.
 *
 *   node scripts/check-release-version.mjs --tag v0.1.0
 *     The same check, plus: the tag (with its leading "v" stripped) must
 *     equal that version too. This is what release.yml runs, passing the
 *     pushed tag explicitly rather than reading GITHUB_REF_NAME itself.
 *
 * Never normalizes or edits a version — a mismatch is reported and the
 * process exits non-zero. Fixing it is `scripts/set-version.mjs`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import semver from 'semver';
import { isExactSemVer } from './semver-utils.mjs';
import { isDirectExecution } from './direct-execution.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Pure comparison, exported for tests: no filesystem, no process.exit.
 * `tag` is optional; when omitted only cross-manifest consistency is checked.
 */
export function findVersionMismatches({
  rootPkg,
  rootLock,
  rootLockPackage,
  extPkg,
  extLock,
  extLockPackage,
  tag,
}) {
  const readings = [
    ['package.json', rootPkg],
    ['package-lock.json (top level)', rootLock],
    ['package-lock.json (root package)', rootLockPackage],
    ['extension/package.json', extPkg],
    ['extension/package-lock.json (top level)', extLock],
    ['extension/package-lock.json (root package)', extLockPackage],
  ];

  const problems = [];
  for (const [label, version] of readings) {
    if (!isExactSemVer(version)) {
      problems.push(`${label} contains invalid semantic version "${version}".`);
    }
  }

  const distinct = new Set(readings.map(([, version]) => version));
  if (distinct.size > 1) {
    problems.push(
      'Version mismatch across manifests — every artifact must ship the same version:',
      ...readings.map(([label, version]) => `  ${label}: ${version}`),
    );
  }

  if (tag !== undefined) {
    const tagVersion = typeof tag === 'string' && tag.startsWith('v') ? tag.slice(1) : '';
    const artifactVersion = rootPkg;
    const validTagVersion = isExactSemVer(tagVersion) ? tagVersion : null;

    if (validTagVersion && semver.prerelease(validTagVersion) !== null) {
      problems.push(
        'Automated releases only accept stable semantic versions.',
        'Prerelease tags must not be published through release.yml.',
      );
    } else {
      const exactStableVersion = validTagVersion
        ? `${semver.major(validTagVersion)}.${semver.minor(validTagVersion)}.${semver.patch(validTagVersion)}`
        : undefined;
      if (!validTagVersion || tagVersion !== exactStableVersion) {
        problems.push(
          `Invalid release tag "${tag}". Automated releases require an exact stable tag in the form vX.Y.Z.`,
        );
      } else if (tagVersion !== artifactVersion) {
        problems.push(
          `Tag/version mismatch: git tag "${tag}" implies version "${tagVersion}", ` +
            `but the artifact version is "${artifactVersion}".`,
        );
      }
    }
  }

  return problems;
}

function readVersions(root) {
  const rootPackageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const rootPackageLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const extensionPackageJson = JSON.parse(
    readFileSync(join(root, 'extension', 'package.json'), 'utf8'),
  );
  const extensionPackageLock = JSON.parse(
    readFileSync(join(root, 'extension', 'package-lock.json'), 'utf8'),
  );

  return {
    rootPkg: rootPackageJson.version,
    rootLock: rootPackageLock.version,
    rootLockPackage: rootPackageLock.packages?.['']?.version,
    extPkg: extensionPackageJson.version,
    extLock: extensionPackageLock.version,
    extLockPackage: extensionPackageLock.packages?.['']?.version,
  };
}

function parseTag(argv) {
  const flag = argv.find((arg) => arg === '--tag' || arg.startsWith('--tag='));
  if (!flag) return undefined;
  if (flag.includes('=')) return flag.slice('--tag='.length);
  const index = argv.indexOf(flag);
  return argv[index + 1] ?? '';
}

// Only runs the CLI when this file is executed directly, not when imported by tests.
if (isDirectExecution(import.meta.url)) {
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
