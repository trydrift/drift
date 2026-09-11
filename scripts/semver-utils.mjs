import semver from 'semver';

// node-semver intentionally accepts convenience prefixes such as `v` and
// returns a normalized value. Manifests and version:set require the canonical
// SemVer spelling itself, including any legitimate prerelease/build metadata.
export function isExactSemVer(value) {
  if (typeof value !== 'string' || semver.valid(value) === null) return false;

  const parsed = semver.parse(value);
  const prerelease = parsed.prerelease.length > 0 ? `-${parsed.prerelease.join('.')}` : '';
  const build = parsed.build.length > 0 ? `+${parsed.build.join('.')}` : '';
  return value === `${parsed.major}.${parsed.minor}.${parsed.patch}${prerelease}${build}`;
}
