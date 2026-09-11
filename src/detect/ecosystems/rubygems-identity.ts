/**
 * RubyGems distinguishes a gem's **version** from the **platform** its artifact
 * was built for. Bundler writes both into one lockfile token:
 *
 *     google-protobuf (4.36.0-x86_64-linux-gnu)
 *
 * Here `4.36.0` is the registry version and `x86_64-linux-gnu` is a
 * `Gem::Platform`. Treating the whole token as the version invents a release
 * that RubyGems never published, and makes the platform-generic gem of the same
 * version look like an upgrade.
 *
 * Hyphens are *also* legal inside a `Gem::Version` (`1.0.0-rc1` means
 * `1.0.0.pre.rc1`), so a suffix may not be stripped merely because it contains
 * `linux` or `darwin`. A suffix is only split off when it is positively
 * identified as a platform: first from the lockfile's own `PLATFORMS` section,
 * and otherwise from `Gem::Platform`'s documented cpu/os structure.
 */

export interface ResolvedGemIdentity {
  /** The RubyGems version — what the registry publishes and orders. */
  version: string;
  /** The `Gem::Platform` string, when the artifact is platform-specific. */
  platform?: string;
}

/** Platform tokens that stand alone, without a cpu prefix. */
const STANDALONE_PLATFORMS = new Set(['java', 'dalvik', 'dotnet', 'universal', 'mswin32', 'mswin64']);

/** `Gem::Platform` cpu values. */
const PLATFORM_CPUS = new Set([
  'aarch64',
  'arm',
  'arm64',
  'armv5',
  'armv6',
  'armv7',
  'i386',
  'i486',
  'i586',
  'i686',
  'mips',
  'powerpc',
  'powerpc64',
  'ppc',
  'ppc64',
  'riscv64',
  's390x',
  'sparc',
  'sparcv9',
  'universal',
  'x64',
  'x86',
  'x86_64',
]);

/** `Gem::Platform` os values. */
const PLATFORM_OSES = new Set([
  'aix',
  'bsd',
  'cygwin',
  'dalvik',
  'darwin',
  'dotnet',
  'freebsd',
  'hpux',
  'java',
  'linux',
  'macruby',
  'mingw',
  'mingw32',
  'mswin',
  'mswin32',
  'mswin64',
  'netbsdelf',
  'openbsd',
  'solaris',
  'wasi',
  'windows',
]);

/**
 * A `PLATFORMS` entry from a Bundler lockfile is authoritative for that file,
 * so collect them before splitting any spec token.
 */
export function parseLockfilePlatforms(content: string): string[] {
  const platforms: string[] = [];
  let inPlatforms = false;
  for (const raw of content.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^PLATFORMS\s*$/.test(line)) {
      inPlatforms = true;
      continue;
    }
    if (line.trim() && !/^\s/.test(line)) {
      inPlatforms = false;
      continue;
    }
    if (!inPlatforms) continue;
    const value = line.trim();
    if (value && value !== 'ruby') platforms.push(value);
  }
  return platforms;
}

/**
 * Split a Bundler spec token into version and platform.
 *
 * `declared` are the platforms the lockfile itself names. Anything not covered
 * by them must still look structurally like a `Gem::Platform` to be split off,
 * so real version qualifiers (`1.0.0-rc1`, `4.0.0.beta1`) survive untouched.
 */
export function resolveGemIdentity(token: string, declared: readonly string[] = []): ResolvedGemIdentity {
  const value = token.trim();
  if (!value.includes('-')) return { version: value };

  for (const platform of declared) {
    const suffix = `-${platform}`;
    if (platform && value.length > suffix.length && value.endsWith(suffix)) {
      return { version: value.slice(0, -suffix.length), platform };
    }
  }

  // Longest structural match wins: `x86_64-linux-gnu` before `x86_64-linux`.
  const parts = value.split('-');
  for (let start = 1; start < parts.length; start++) {
    const candidate = parts.slice(start).join('-');
    if (isGemPlatform(candidate)) {
      return { version: parts.slice(0, start).join('-'), platform: candidate };
    }
  }

  return { version: value };
}

/** Does this token match `Gem::Platform`'s cpu[-os[-version]] shape? */
function isGemPlatform(token: string): boolean {
  const lower = token.toLowerCase();
  if (STANDALONE_PLATFORMS.has(lower)) return true;

  const parts = lower.split('-');
  if (parts.length < 2) return false;
  if (!PLATFORM_CPUS.has(parts[0]!)) return false;
  if (!PLATFORM_OSES.has(parts[1]!)) return false;
  // The optional third field is an os version or ABI (`gnu`, `musl`, `23`,
  // `ucrt`). Anything longer is not a platform Drift will claim to recognise.
  return parts.length <= 3 && parts.slice(2).every((part) => /^[a-z0-9_.]+$/.test(part));
}
