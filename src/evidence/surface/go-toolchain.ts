import type { Exec } from '../../util/exec.js';

/**
 * Finding, and describing, the Go toolchain.
 *
 * Drift does not ship Go, so "is `go` on the PATH?" is a question with three
 * useful answers, not two: it is there, it is missing and we know which version
 * this repository needs, or it is missing and we do not. The third is the least
 * actionable, so this module works hard to avoid returning it — a repository
 * with a `go.mod` always tells us the version, and that turns a dead end into
 * one line a developer can paste into a workflow.
 */

/** A Go version requirement, and the file it was read from. */
export interface GoVersionRequirement {
  /** `1.24`, or `1.24.3` when the file pinned a patch. */
  version: string;
  /** Repo-relative path, or a description when the value is a default. */
  source: string;
}

/**
 * The version used when a repository says nothing.
 *
 * Deliberately a released, widely-available minor rather than the newest one:
 * this value is only ever reached when Drift has no evidence, and guessing
 * ahead of a repository is how a suggested workflow fails to run.
 */
export const DEFAULT_GO_VERSION = '1.24';

/** Reads a repository file by repo-relative path. Resolves `null` when absent. */
export type RepoFileReader = (path: string) => Promise<string | null>;

/**
 * Platforms the API is extracted for.
 *
 * Go's build constraints mean a module's exported API is a function of GOOS and
 * GOARCH: `golang.org/x/sys/windows` does not exist on Linux, and half of
 * `unix` does not exist on Windows. Comparing a single platform would report
 * every other platform's API as absent on both sides — invisible rather than
 * wrong, which is worse.
 *
 * Three pairs cover the overwhelming majority of what a Go repository targets
 * while keeping the parse cost bounded; the host platform is added when it is
 * not already one of them.
 */
export const DEFAULT_GO_PLATFORMS = ['linux/amd64', 'darwin/arm64', 'windows/amd64'] as const;

/** The platform set to extract for, including the host when it is unusual. */
export function goPlatforms(): string[] {
  const platforms = [...DEFAULT_GO_PLATFORMS];
  const host = `${hostGoos()}/${hostGoarch()}`;
  return platforms.includes(host as (typeof DEFAULT_GO_PLATFORMS)[number])
    ? platforms
    : [...platforms, host];
}

function hostGoos(): string {
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'darwin';
    default:
      return 'linux';
  }
}

function hostGoarch(): string {
  switch (process.arch) {
    case 'x64':
      return 'amd64';
    case 'arm64':
      return 'arm64';
    case 'arm':
      return 'arm';
    default:
      return 'amd64';
  }
}

export interface GoToolchain {
  available: boolean;
  /** `1.24.3`, when `go version` could be read. */
  version?: string;
  /** Absolute path of the module cache, when the toolchain reported one. */
  moduleCache?: string;
}

/**
 * Probe the installed Go toolchain.
 *
 * `go version` is the availability test and the version read in one command,
 * because a `go` that is on the PATH but cannot run is not an available
 * toolchain and reporting it as one produces a confusing failure two steps
 * later.
 */
export async function probeGoToolchain(exec: Exec, env?: NodeJS.ProcessEnv): Promise<GoToolchain> {
  const version = await exec('go', ['version'], { timeoutMs: 20_000, ...(env ? { env } : {}) });
  if (version.failure === 'not-found' || version.code !== 0) return { available: false };
  const parsed = /go(\d+\.\d+(?:\.\d+)?)/.exec(version.stdout)?.[1];

  const cache = await exec('go', ['env', 'GOMODCACHE'], { timeoutMs: 20_000, ...(env ? { env } : {}) });
  const moduleCache = cache.code === 0 ? cache.stdout.trim() : '';

  return {
    available: true,
    ...(parsed ? { version: parsed } : {}),
    ...(moduleCache ? { moduleCache } : {}),
  };
}

/**
 * The Go version this repository is built with.
 *
 * Read in the order a Go developer would trust: the workspace file wins over
 * the module file when both exist, because `go.work` is what the toolchain
 * itself obeys; a workflow's `go-version` is the next best statement of intent;
 * and the default is a last resort that is labelled as one.
 */
export async function requiredGoVersion(
  readRepoFile: RepoFileReader | undefined,
  candidates: readonly string[] = GO_VERSION_SOURCES,
): Promise<GoVersionRequirement> {
  if (readRepoFile) {
    for (const path of candidates) {
      const content = await readRepoFile(path).catch(() => null);
      if (!content) continue;
      const version = path.endsWith('.yml') || path.endsWith('.yaml')
        ? goVersionFromWorkflow(content)
        : goVersionFromModuleFile(content);
      if (version) return { version, source: path };
    }
  }

  return { version: DEFAULT_GO_VERSION, source: 'Drift default' };
}

/**
 * Where a Go version is looked for, in order.
 *
 * The workflow paths are guesses at a conventional name rather than a scan:
 * evidence gathering reads named files, and walking `.github/workflows` for
 * every repository to find a version string that `go.mod` almost always
 * carries anyway is not worth the requests.
 */
export const GO_VERSION_SOURCES = [
  'go.work',
  'go.mod',
  '.github/workflows/go.yml',
  '.github/workflows/ci.yml',
  '.github/workflows/test.yml',
  '.github/workflows/build.yml',
] as const;

/**
 * The `go` and `toolchain` directives of a `go.mod` or `go.work`.
 *
 * `toolchain go1.24.3` wins when present: it is the stricter of the two, and it
 * is what the toolchain will actually select.
 */
export function goVersionFromModuleFile(content: string): string | null {
  const toolchain = /^\s*toolchain\s+go(\d+\.\d+(?:\.\d+)?)/m.exec(content)?.[1];
  if (toolchain) return toolchain;
  return /^\s*go\s+(\d+\.\d+(?:\.\d+)?)/m.exec(content)?.[1] ?? null;
}

/**
 * The `go-version` of a `setup-go` step.
 *
 * Parsed with a regex rather than the YAML loader because this runs against
 * arbitrary repository files: a workflow that does not parse is an ordinary
 * outcome here, and a matrix expression like `${{ matrix.go }}` is correctly
 * *not* a version, which is what the digit anchor enforces.
 */
export function goVersionFromWorkflow(content: string): string | null {
  const direct = /go-version(?:-file)?\s*:\s*['"]?(\d+\.\d+(?:\.\d+|\.x)?)/.exec(content)?.[1];
  if (!direct) return null;
  return direct.replace(/\.x$/, '');
}

/**
 * What a developer should do to get an API comparison next time.
 *
 * Named with the version the repository actually asks for, because "install Go"
 * is advice and "install Go 1.24" is an instruction.
 */
export function goRemedy(requirement: GoVersionRequirement, inActions: boolean): string {
  const version = requirement.version;
  if (inActions) {
    return `Add \`actions/setup-go\` with \`go-version: '${version}'\` to the Drift workflow, before the Drift step, to enable exported-API comparison.`;
  }
  return `Install Go ${version} and make \`go\` available on PATH, or configure \`go-version\` in the Drift workflow, to enable exported-API comparison.`;
}

/** True when this process is running inside a GitHub Actions runner. */
export function inGitHubActions(): boolean {
  return process.env.GITHUB_ACTIONS === 'true';
}
