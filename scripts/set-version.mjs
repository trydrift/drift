#!/usr/bin/env node
/**
 * The one supported way to change the product version. Updates the four
 * files `check-release-version.mjs` requires to agree — package.json and
 * package-lock.json at the root, and the same pair under extension/ — and
 * nothing else.
 *
 * Usage:
 *   node scripts/set-version.mjs 0.1.1
 *
 * Does not create a git tag or a commit. Version changes and tag creation
 * are deliberately separate actions — commit the result yourself, review it,
 * then tag.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

const version = process.argv[2];
if (!version) {
  console.error('Usage: node scripts/set-version.mjs <version>');
  console.error('Example: node scripts/set-version.mjs 0.1.1');
  process.exit(1);
}
if (!SEMVER.test(version)) {
  console.error(`"${version}" is not a valid semantic version (expected e.g. 0.1.1 or 0.1.1-beta.0).`);
  process.exit(1);
}

function updatePackageJson(path) {
  const json = JSON.parse(readFileSync(path, 'utf8'));
  json.version = version;
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
}

function updateLockfile(path) {
  const json = JSON.parse(readFileSync(path, 'utf8'));
  json.version = version;
  if (json.packages?.['']) json.packages[''].version = version;
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
}

updatePackageJson(join(repoRoot, 'package.json'));
updateLockfile(join(repoRoot, 'package-lock.json'));
updatePackageJson(join(repoRoot, 'extension', 'package.json'));
updateLockfile(join(repoRoot, 'extension', 'package-lock.json'));

console.log(`Set version to ${version} in package.json, package-lock.json, extension/package.json, extension/package-lock.json.`);
console.log('Review the diff, commit it, then run `npm run release:check` before tagging.');
