import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import semver from 'semver';

const run = promisify(execFile);

/**
 * The PATH a GUI-launched VS Code sees is not the PATH a terminal sees.
 *
 * On macOS and Linux, apps launched from the Dock or Finder inherit the
 * login environment, not the interactive shell environment — so PATH
 * entries added by nvm, volta, fnm, or asdf (almost always sourced from
 * `.zshrc`/`.bashrc`, which only run for interactive shells) are invisible
 * to `child_process.execFile`. This is why `npm`, found by hand in any
 * terminal, comes back `spawn npm ENOENT` from inside the extension host.
 *
 * Two independent signals are combined, because either one alone has a real
 * failure mode:
 *
 * - Asking the user's own shell for its PATH (`$SHELL -ilc 'echo $PATH'`,
 *   the same trick VS Code's own integrated terminal uses) is the most
 *   accurate signal when it works, but it depends on the shell actually
 *   starting cleanly non-interactively — a slow prompt framework, a plugin
 *   that errors on a non-tty, or a shell (fish, in particular) whose flag
 *   parsing does not match this invocation can silently fail it.
 * - Probing the well-known install directories for nvm, volta, fnm, and
 *   asdf costs nothing, depends on no shell behaviour at all, and covers
 *   the version manager that put npm on the machine in the first place even
 *   when the shell probe above comes back empty.
 *
 * Resolved once per session and cached, since neither signal is free.
 */
let cached: Promise<string> | undefined;

export function resolveShellPath(): Promise<string> {
  cached ??= computeShellPath();
  return cached;
}

/** Test-only: drop the cached PATH so the next call recomputes it. */
export function resetShellPathCache(): void {
  cached = undefined;
}

async function computeShellPath(): Promise<string> {
  const base = process.env.PATH ?? '';
  if (process.platform === 'win32') return base;

  const [shellPath, versionManagerDirs] = await Promise.all([shellDerivedPath(), versionManagerBinDirs()]);
  return mergePaths(shellPath ?? '', versionManagerDirs.join(delimiter), base);
}

async function shellDerivedPath(): Promise<string | null> {
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    // -i (interactive) makes zsh/bash source .zshrc/.bashrc, where nvm/volta/
    // fnm/asdf install their PATH entries. -l (login) covers profile-only
    // setups. Neither flag on its own reliably covers every install method.
    const { stdout } = await run(shell, ['-ilc', 'echo -n "__DRIFT_PATH__$PATH__DRIFT_PATH__"'], {
      timeout: 12_000,
      windowsHide: true,
    });
    const match = /__DRIFT_PATH__(.*)__DRIFT_PATH__/s.exec(stdout);
    return match?.[1]?.trim() || null;
  } catch {
    // A shell that fails to start non-interactively (unusual prompt logic,
    // a plugin that errors on a non-tty, a shell whose flags this doesn't
    // match) is not a reason to fail every command — `versionManagerBinDirs`
    // is the fallback signal for exactly this case.
    return null;
  }
}

/**
 * Node version managers each keep their binaries somewhere `$SHELL -ilc`
 * should — but does not always — surface: nvm and fnm install one directory
 * per Node version with no fixed path, volta and asdf use a stable one.
 *
 * nvm and fnm don't get their *active* version resolved here — that would
 * mean parsing nvm's alias chain or fnm's own state, either of which can
 * change shape between versions of the tool. The highest installed version
 * is deliberately good enough: this exists to make `npm install` runnable
 * at all, not to match whichever Node version the user's shell prompt says
 * is active.
 */
async function versionManagerBinDirs(): Promise<string[]> {
  const home = process.env.HOME;
  if (!home) return [];

  const dirs = await Promise.all([
    existingBinDir(join(home, '.volta', 'bin')),
    latestVersionBinDir(join(home, '.nvm', 'versions', 'node'), 'bin'),
    latestVersionBinDir(join(home, '.local', 'share', 'fnm', 'node-versions'), join('installation', 'bin')),
    latestVersionBinDir(join(home, '.asdf', 'installs', 'nodejs'), 'bin'),
  ]);

  return dirs.filter((dir): dir is string => dir !== null);
}

async function existingBinDir(dir: string): Promise<string | null> {
  try {
    await access(join(dir, 'npm'), constants.F_OK);
    return dir;
  } catch {
    return null;
  }
}

/** The highest semver-named subdirectory of `base`, with `binSuffix` appended, if it holds `npm`. */
async function latestVersionBinDir(base: string, binSuffix: string): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return null;
  }

  const versions = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => semver.valid(name.replace(/^v/, '')))
    .sort((a, b) => semver.rcompare(a.replace(/^v/, ''), b.replace(/^v/, '')));

  for (const version of versions) {
    const dir = join(base, version, binSuffix);
    if (await existingBinDir(dir)) return dir;
  }
  return null;
}

function mergePaths(...paths: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    for (const entry of path.split(delimiter)) {
      if (entry && !seen.has(entry)) {
        seen.add(entry);
        out.push(entry);
      }
    }
  }
  return out.join(delimiter);
}

/** `process.env`, with PATH replaced by the resolved shell PATH. */
export async function envWithShellPath(): Promise<NodeJS.ProcessEnv> {
  return { ...process.env, PATH: await resolveShellPath() };
}
