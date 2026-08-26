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
import { isExactSemVer } from './semver-utils.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export function isValidVersion(version) {
  return isExactSemVer(version);
}

function replaceVersionProperty(source, currentVersion, nextVersion, fromIndex = 0) {
  const property = /("version"\s*:\s*)"([^"]*)"/g;
  property.lastIndex = fromIndex;

  for (let match = property.exec(source); match; match = property.exec(source)) {
    if (match[2] !== currentVersion) continue;
    const valueStart = match.index + match[1].length;
    const valueEnd = valueStart + JSON.stringify(currentVersion).length;
    const replacement = JSON.stringify(nextVersion);
    return {
      source: source.slice(0, valueStart) + replacement + source.slice(valueEnd),
      nextIndex: valueStart + replacement.length,
    };
  }

  throw new Error(`Could not find version property "${currentVersion}" to update.`);
}

export function updateManifestText(source, version) {
  const manifest = JSON.parse(source);
  return replaceVersionProperty(source, manifest.version, version).source;
}

export function updateLockfileText(source, version) {
  const lockfile = JSON.parse(source);
  if (typeof lockfile.packages?.['']?.version !== 'string') {
    throw new Error('Lockfile is missing packages[""].version.');
  }

  const root = replaceVersionProperty(source, lockfile.version, version);
  return replaceVersionProperty(
    root.source,
    lockfile.packages[''].version,
    version,
    root.nextIndex,
  ).source;
}

function updateJsonFile(path, update, version) {
  const source = readFileSync(path, 'utf8');
  writeFileSync(path, update(source, version));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const version = process.argv[2];
  if (!version) {
    console.error('Usage: node scripts/set-version.mjs <version>');
    console.error('Example: node scripts/set-version.mjs 0.1.1');
    process.exit(1);
  }
  if (!isValidVersion(version)) {
    console.error(`"${version}" is not a valid semantic version (expected e.g. 0.1.1 or 0.1.1-beta.0).`);
    process.exit(1);
  }

  updateJsonFile(join(repoRoot, 'package.json'), updateManifestText, version);
  updateJsonFile(join(repoRoot, 'package-lock.json'), updateLockfileText, version);
  updateJsonFile(join(repoRoot, 'extension', 'package.json'), updateManifestText, version);
  updateJsonFile(join(repoRoot, 'extension', 'package-lock.json'), updateLockfileText, version);

  console.log(`Set version to ${version} in package.json, package-lock.json, extension/package.json, extension/package-lock.json.`);
  console.log('Review the diff, commit it, then run `npm run release:check` before tagging.');
}
