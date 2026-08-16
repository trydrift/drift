import { cp, copyFile, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execCommand, type Exec } from '../util/exec.js';

/**
 * A throwaway checkout of the repository, for work that must not touch the
 * developer's tree.
 *
 * Drift installs upgrades and runs the project's own checks against them. Doing
 * that where someone is working means their `node_modules` moves under them,
 * their editor reindexes, and a scan they did not ask to be invasive has edited
 * their tree. A worktree is git's own answer to that: the same commit, a
 * separate directory, removed when the work is done.
 *
 * Three places grew their own copy of this — the extension's `Git` class, the
 * CLI's fix runner, and (now) the scan probe — with three different cleanup
 * stories. This is the one both `src/` consumers use, so an interrupted run
 * leaves the same trace everywhere and `dispose` means the same thing.
 */

export interface Worktree {
  /** Absolute path of the checkout. */
  path: string;
  /**
   * Repo-relative paths of gitignored files carried over from `root` — the
   * same files a `build` run in the developer's own checkout would see.
   * Empty when `copyIgnoredFiles` was off or there was nothing gitignored
   * outside the usual regenerable directories.
   */
  copiedFiles: readonly string[];
  /**
   * The `.gitignore` patterns that matched {@link copiedFiles}, deduplicated —
   * the rule alone (`dist/`), not `git check-ignore -v`'s file-and-line prefix
   * — what a reader needs to find and, if wrong, adjust the rule, without
   * scrolling past a file-by-file dump that is often mostly noise (a single
   * `dist/` rule can match hundreds of files).
   */
  copiedRules: readonly string[];
  /**
   * Gitignored files that qualified for copying but were skipped for being
   * larger than {@link MAX_COPY_BYTES}. Reported rather than silently
   * dropped: a build that still fails in the worktree because of one of
   * these should say so, not repeat the same unexplained failure this
   * feature exists to prevent.
   */
  oversizedFiles: readonly string[];
  /** The `.gitignore` rules that matched {@link oversizedFiles}, same format as {@link copiedRules}. */
  oversizedRules: readonly string[];
  /**
   * Gitignored files that matched {@link SENSITIVE_PATTERNS} and were never
   * copied — an `.env`, a private key, an `.npmrc` with a registry token —
   * regardless of {@link WorktreeOptions.allowedGlobs}. A worktree runs an
   * upgrade candidate's own install/build/test scripts, which is untrusted
   * code by the definition of the exercise; a secret sitting next to it is
   * a secret that code can read.
   */
  skippedSecrets: readonly string[];
  /** The `.gitignore` rules that matched {@link skippedSecrets}, same format as {@link copiedRules}. */
  skippedSecretRules: readonly string[];
  /** Remove it. Safe to call more than once, and never throws. */
  dispose(): Promise<void>;
}

export interface WorktreeOptions {
  /** Commit-ish to check out. Defaults to `HEAD`. */
  at?: string;
  /** Runs the git commands. Injected by tests. */
  exec?: Exec;
  env?: NodeJS.ProcessEnv;
  /**
   * Carry over gitignored files from `root`, e.g. generated code a build
   * step expects to already exist. On by default — see
   * {@link copyIgnoredSourceFiles}. Set `false` for work that means to
   * measure the commit exactly as checked in, with nothing local added.
   *
   * A sensitive file (see {@link SENSITIVE_PATTERNS}) is never copied
   * regardless of this setting.
   */
  copyIgnoredFiles?: boolean;
  /**
   * Restrict the gitignored files carried over to these repo-relative glob
   * patterns (`**` crosses directories, `*` and `?` do not), instead of
   * every gitignored file outside {@link REGENERABLE_SEGMENTS}. Unset by
   * default, which keeps the broader auto-copy behavior — set this to make
   * what gets carried into a worktree explicit and auditable rather than
   * "everything that isn't obviously regenerated".
   */
  allowedGlobs?: readonly string[];
  /**
   * Namespaces this worktree's path so two concurrent Drift processes
   * scanning the same repository never collide on, or force-remove, each
   * other's in-progress worktree. Defaults to one value generated per
   * process (see {@link DEFAULT_RUN_ID}) — every worktree a single scan
   * creates shares it, so labels like `probe-root` stay unique to *this*
   * run without every caller having to invent one. Overridable so tests can
   * assert on a stable path.
   */
  runId?: string;
}

/**
 * Check `root`'s HEAD out into a fresh directory under the repository's own
 * git dir.
 *
 * Detached on purpose: this checkout exists to be measured, never to be
 * committed to, and a named branch would show up in the developer's branch list
 * as something they might reasonably try to merge.
 *
 * Throws when git will not produce one and the caller asked for a specific
 * commit-ish — a corrupt index, a commit that does not resolve, or no
 * repository at all when {@link WorktreeOptions.at} names something other
 * than `HEAD`. When `root` is not a git repository and no specific commit
 * was requested (the default, `HEAD` — "whatever is on disk right now"),
 * this falls back to a plain recursive copy into a temp directory instead:
 * a candidate verified from a local checkout is as often a directory nobody
 * has run `git init` in yet as it is a repository, and skipping verification
 * entirely there would silently let every finding through unverified. The
 * copy applies the same regenerable-directory and secret-shaped denylists as
 * the gitignored-file carry-over below, since there is no git to ask what's
 * tracked. A caller that can degrade should still catch and say what it
 * could not verify rather than failing the whole scan.
 */
export async function createWorktree(
  root: string,
  label: string,
  options: WorktreeOptions = {},
): Promise<Worktree> {
  const exec = options.exec ?? execCommand;
  const env = options.env ?? process.env;
  const at = options.at ?? 'HEAD';

  const common = await exec('git', ['rev-parse', '--git-common-dir'], { cwd: root, env });
  if (common.code !== 0) {
    if (options.at !== undefined && options.at !== 'HEAD') {
      throw new Error(
        `\`${root}\` is not a git repository, so \`${options.at}\` cannot be checked out to test an upgrade.`,
      );
    }
    return createFallbackCheckout(root, label, options.runId ?? DEFAULT_RUN_ID);
  }

  // `--git-common-dir` is relative to `root` for an ordinary checkout (`.git`),
  // but a *linked* worktree — Drift itself checked out with `git worktree
  // add`, which its own CI and contributors both do — prints the absolute
  // path of the main checkout's real `.git` directory instead. Joining that
  // absolute path onto `root` again silently produced a nonsense nested path
  // instead of erroring, so verification worked everywhere except from the
  // one checkout shape this whole module exists to create.
  const gitDir = common.stdout.trim() || '.git';
  const commonDir = isAbsolute(gitDir) ? gitDir : join(root, gitDir);
  const runId = options.runId ?? DEFAULT_RUN_ID;
  const path = join(commonDir, 'drift-worktrees', sanitize(runId), sanitize(label));

  // A previous run that was killed rather than finished leaves both a directory
  // and a registration behind, and `worktree add` refuses either. Clearing both
  // before adding is what makes an interrupted scan recoverable without the
  // developer being told to run `git worktree prune` by hand. Scoped to this
  // run's own namespaced path, never another run's — see `runId` above.
  await exec('git', ['worktree', 'remove', '--force', path], { cwd: root, env });
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
  await exec('git', ['worktree', 'prune'], { cwd: root, env });

  const added = await exec('git', ['worktree', 'add', '--detach', path, at], { cwd: root, env });
  if (added.code !== 0) {
    throw new Error(
      `Could not create a worktree to test upgrades in: ${added.stderr.trim() || added.stdout.trim() || 'git failed'}`,
    );
  }

  const { copied, oversized, secrets } =
    options.copyIgnoredFiles === false
      ? { copied: [], oversized: [], secrets: [] }
      : await copyIgnoredSourceFiles(root, path, exec, env, undefined, options.allowedGlobs);
  const [copiedRules, oversizedRules, skippedSecretRules] = await Promise.all([
    gitignoreRules(root, copied, exec, env),
    gitignoreRules(root, oversized, exec, env),
    gitignoreRules(root, secrets, exec, env),
  ]);

  let disposed = false;
  return {
    path,
    copiedFiles: copied,
    copiedRules,
    oversizedFiles: oversized,
    oversizedRules,
    skippedSecrets: secrets,
    skippedSecretRules,
    async dispose() {
      if (disposed) return;
      disposed = true;
      // Every step is best-effort and independently attempted: a worktree left
      // behind is a wasted gigabyte, but a cleanup that throws would replace
      // whatever real error the caller is already handling.
      await exec('git', ['worktree', 'remove', '--force', path], { cwd: root, env }).catch(() => undefined);
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
      await exec('git', ['worktree', 'prune'], { cwd: root, env }).catch(() => undefined);
    },
  };
}

/**
 * The non-git twin of {@link createWorktree}: a plain recursive copy of
 * `root` into a temp directory, for a candidate directory that has never
 * been `git init`'d. There is no index to ask what's tracked, so this copies
 * everything except the directories a fresh install or build regenerates on
 * its own ({@link REGENERABLE_SEGMENTS}) and anything secret-shaped
 * ({@link SENSITIVE_PATTERNS}, reported the same way a git-backed worktree
 * reports the gitignored files it declined to carry over). Never throws —
 * a failed copy is reported to the caller as a normal `Error`, the same as a
 * failed `git worktree add`.
 */
async function createFallbackCheckout(root: string, label: string, runId: string): Promise<Worktree> {
  const path = join(tmpdir(), 'drift-worktrees', sanitize(runId), sanitize(label));

  await rm(path, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(path, { recursive: true });

  const skippedSecrets: string[] = [];
  try {
    await cp(root, path, {
      recursive: true,
      filter: (source) => {
        const rel = relative(root, source);
        if (rel === '') return true;
        const relPosix = rel.split(sep).join('/');
        if (rel.split(sep).some((segment) => REGENERABLE_SEGMENTS.has(segment))) return false;
        if (isSensitivePath(relPosix)) {
          skippedSecrets.push(relPosix);
          return false;
        }
        return true;
      },
    });
  } catch (err) {
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(
      `Could not copy \`${root}\` into a temp checkout to test an upgrade: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let disposed = false;
  return {
    path,
    copiedFiles: [],
    copiedRules: [],
    oversizedFiles: [],
    oversizedRules: [],
    skippedSecrets: skippedSecrets.sort(),
    skippedSecretRules: [],
    async dispose() {
      if (disposed) return;
      disposed = true;
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/**
 * One namespace per process, so every worktree a single `drift` invocation
 * creates shares it. Two concurrent invocations — two terminals, a scan
 * racing a `drift fix`, two CI jobs on the same self-hosted runner's
 * checkout — get different namespaces and therefore different paths, so
 * neither can force-remove a worktree the other is still using.
 */
const DEFAULT_RUN_ID = `${process.pid}-${randomBytes(4).toString('hex')}`;

/**
 * Run `work` in a fresh worktree and remove it afterwards, whatever happens.
 *
 * The pattern every caller wants, in the shape that makes leaking one
 * impossible.
 */
export async function withWorktree<T>(
  root: string,
  label: string,
  work: (worktree: Worktree) => Promise<T>,
  options: WorktreeOptions = {},
): Promise<T> {
  const worktree = await createWorktree(root, label, options);
  try {
    return await work(worktree);
  } finally {
    await worktree.dispose();
  }
}

/**
 * Directory segments that mark a gitignored path as regenerable rather than a
 * checked-in input: caches, dependency trees, and build output a fresh
 * install or build step recreates on its own. Never worth carrying into a
 * worktree, and often too large to try.
 */
const REGENERABLE_SEGMENTS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.cache',
  '.parcel-cache',
  '.turbo',
  '.angular',
  'coverage',
  'target',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.gradle',
  '.idea',
  '.vscode',
  'tmp',
  '.tmp',
]);

/**
 * Ignored files this large are copied output or data, not the kind of small
 * hand-generated source a build reads as an input — and copying one this size
 * on every worktree would make the feature cost more than the failure it
 * prevents. Reported rather than silently skipped, in case it's wrong for a
 * given repository.
 */
const MAX_COPY_BYTES = 25 * 1024 * 1024;

/**
 * Filenames and extensions never carried into a worktree, whatever else is
 * configured to be copied — a worktree exists to run an upgrade candidate's
 * own install/build/test scripts, and those scripts are, by definition,
 * code nobody has reviewed yet. Matched against the path's basename and
 * against the full repo-relative path, case-insensitively.
 *
 * Deliberately a denylist of *shapes* (`.env*`, `*.pem`, anything with
 * "credentials" in the name) rather than an attempt to enumerate every tool
 * that might drop a secret on disk — new secret-shaped files show up faster
 * than this list could be kept exhaustive, and a false positive here costs
 * nothing (the file simply isn't copied) where a false negative costs a
 * leaked token.
 */
const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.env(\..*)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.yarnrc(\.yml)?$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.pgpass$/i,
  /(^|\/)\.git-credentials$/i,
  /(^|\/)\.dockercfg$/i,
  /(^|\/)\.docker\/config\.json$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|ppk)$/i,
  /(^|\/)(\.aws\/credentials|\.aws\/config)$/i,
  /(^|\/)application_default_credentials\.json$/i,
  /(service[-_]?account|credentials?|secrets?)[^/]*\.(json|ya?ml|txt)$/i,
];

function isSensitivePath(rel: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(rel));
}

/**
 * Turns a repo-relative glob (`src/generated/**`, `*.generated.ts`) into a
 * matcher. Supports `**` (any path segments, including none), `*` (any
 * characters within one segment), and `?` (one character within one
 * segment) — enough for the generated-source patterns a project would
 * actually write, without pulling in a glob dependency for it.
 */
function globToRegExp(glob: string): RegExp {
  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    const rest = glob.slice(i);
    if (rest.startsWith('**')) {
      pattern += '.*';
      i += 1;
    } else if (glob[i] === '*') {
      pattern += '[^/]*';
    } else if (glob[i] === '?') {
      pattern += '[^/]';
    } else {
      pattern += glob[i]!.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${pattern}$`);
}

function matchesAnyGlob(rel: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(rel));
}

/**
 * Carry gitignored-but-locally-necessary files from `root` into a fresh
 * worktree.
 *
 * A worktree is `git worktree add`'s checkout: tracked files only. Most
 * repositories are fine with that — `npm install` and a build step rebuild
 * everything gitignored from scratch. Some are not: a codegen step run once
 * and committed nowhere, whose output is `.gitignore`d because it is
 * derived, but which the build reads as if it were source. Without it, every
 * check in the worktree fails the same way a fresh clone would, and Drift
 * reports the whole project as unbuildable rather than saying nothing about
 * the upgrade at all.
 *
 * There is no manifest of which gitignored files are like this, so by default
 * this copies what the developer's own `npm run build` already sees:
 * everything `git` reports as ignored, minus the directories a fresh install
 * or build regenerates on its own ({@link REGENERABLE_SEGMENTS}) and minus
 * anything sensitive-shaped ({@link SENSITIVE_PATTERNS}, never copied
 * regardless of `allowedGlobs`). An earlier version of this tried to guess
 * relevance by grepping tracked source for each file's name, which is
 * exactly backwards — it can miss a file referenced indirectly (a dynamic
 * import, a path built at runtime) and silently reproduce the very failure
 * this exists to prevent. Copying everything the denylist doesn't rule out
 * has no such blind spot — `allowedGlobs` narrows that default down to an
 * explicit, project-declared list instead, for a repository that would
 * rather say exactly what it needs.
 */
export async function copyIgnoredSourceFiles(
  root: string,
  worktreePath: string,
  exec: Exec,
  env: NodeJS.ProcessEnv,
  /** Overridable by tests; production callers get {@link MAX_COPY_BYTES}. */
  maxBytes: number = MAX_COPY_BYTES,
  /** See {@link WorktreeOptions.allowedGlobs}. */
  allowedGlobs?: readonly string[],
): Promise<{ copied: string[]; oversized: string[]; secrets: string[] }> {
  const listed = await exec('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], {
    cwd: root,
    env,
  });
  if (listed.code !== 0 || !listed.stdout) return { copied: [], oversized: [], secrets: [] };

  const ignored = listed.stdout
    .split('\0')
    .filter((rel) => rel.length > 0 && !rel.split('/').some((segment) => REGENERABLE_SEGMENTS.has(segment)));

  const copied: string[] = [];
  const oversized: string[] = [];
  const secrets: string[] = [];
  for (const rel of ignored) {
    if (isSensitivePath(rel)) {
      secrets.push(rel);
      continue;
    }
    // With an explicit allowlist configured, only what it names is eligible —
    // the auto-copy denylist above still applies within that, but nothing
    // outside the allowlist is even considered. Without one, every
    // gitignored, non-regenerable, non-sensitive file is (the long-standing
    // default: Drift cannot know in advance which generated file a build
    // needs, so it copies what a developer's own `npm run build` would see).
    if (allowedGlobs && allowedGlobs.length > 0 && !matchesAnyGlob(rel, allowedGlobs)) continue;

    const source = join(root, rel);
    const info = await stat(source).catch(() => null);
    if (!info || !info.isFile()) continue;
    if (info.size > maxBytes) {
      oversized.push(rel);
      continue;
    }

    const destination = join(worktreePath, rel);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination).catch(() => undefined);
    copied.push(rel);
  }

  return { copied, oversized, secrets };
}

/**
 * Batch size for `git check-ignore` invocations. Comfortably under any
 * platform's argv limit even for a repository with thousands of gitignored
 * files, while keeping the number of process spawns small.
 */
const CHECK_IGNORE_BATCH_SIZE = 200;

/**
 * Look up which `.gitignore` rule matches each of `paths`, and reduce that to
 * the distinct rules involved.
 *
 * A worktree report that lists every carried-over file is often just a
 * restatement of one rule (`dist/` alone can cover hundreds of files) — not
 * useful for a developer deciding whether the copy was the right call. The
 * rule itself, and where it lives, is what they'd need to change the
 * behavior; `git check-ignore -v` already knows both.
 */
export async function gitignoreRules(
  root: string,
  paths: readonly string[],
  exec: Exec,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  if (paths.length === 0) return [];

  const rules = new Set<string>();
  for (let i = 0; i < paths.length; i += CHECK_IGNORE_BATCH_SIZE) {
    const batch = paths.slice(i, i + CHECK_IGNORE_BATCH_SIZE);
    const result = await exec('git', ['check-ignore', '-v', '--', ...batch], { cwd: root, env });
    // Exit code 1 just means "some of these aren't ignored", which cannot
    // happen here since every path came from `git ls-files --ignored`
    // itself — but a stale worktree or a race with the developer's own edits
    // could still make it so, and the rule lookup is best-effort either way.
    if (!result.stdout) continue;
    for (const line of result.stdout.split('\n')) {
      if (!line) continue;
      const tab = line.indexOf('\t');
      if (tab === -1) continue;
      rules.add(ignorePattern(line.slice(0, tab)));
    }
  }

  return [...rules].sort();
}

/**
 * The rule itself, out of `git check-ignore -v`'s `<source>:<line>:<pattern>`.
 *
 * A reader shown `.gitignore:12:dist/` has to parse past a filename and a
 * line number to reach the one token that means anything to them — and the
 * line number is stale the moment anyone edits the file. `dist/` is the whole
 * answer. The greedy first group anchors on the *last* `:<digits>:` in the
 * string, so a pattern containing digits or a source path containing a colon
 * still splits at the right place.
 */
function ignorePattern(source: string): string {
  return /^(.*):(\d+):([^]*)$/.exec(source)?.[3] ?? source;
}

/** Directory-safe, collision-resistant enough for one label per scan. */
function sanitize(label: string): string {
  const cleaned = label.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 80) : 'probe';
}
