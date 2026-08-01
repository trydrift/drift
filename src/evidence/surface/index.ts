import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DependencyChange, Ecosystem } from '../../types.js';
import type { Logger } from '../../util/logger.js';
import { execCommand, type Exec } from '../../util/exec.js';
import { rustSurface } from './rust.js';
import { goSurface } from './go.js';
import { javaSurface } from './java.js';
import { pythonSurface } from './python.js';
import { unavailable, type SurfaceOutcome, type SurfaceProvider } from './types.js';

/**
 * Computed API-surface diffs, one provider per ecosystem.
 *
 * npm is absent on purpose: its provider is `type-surface.ts`, which needs no
 * local toolchain because jsDelivr serves `.d.ts` directly. RubyGems is absent
 * for the opposite reason — Ruby has no static public surface worth the name,
 * and forcing a low-confidence signal into the highest-weight slot would be a
 * lie told by a number.
 */

const PROVIDERS: readonly SurfaceProvider[] = [rustSurface, goSurface, javaSurface, pythonSurface];

export function surfaceProviderFor(ecosystem: Ecosystem): SurfaceProvider | undefined {
  return PROVIDERS.find((p) => p.ecosystem === ecosystem);
}

export interface ComputeOptions {
  logger: Logger;
  exec?: Exec;
  /** Environment to use for local toolchain commands. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Reads a file from the repository under analysis, by repo-relative path. */
  readRepoFile?: (path: string) => Promise<string | null>;
}

const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * Compute the surface diff for one dependency move.
 *
 * Always resolves. Every failure is a stated reason a developer can act on —
 * "japicmp is not installed" and "that version was yanked" lead to different
 * decisions, and collapsing both to "could not check" throws that away.
 */
export async function computeSurfaceDiff(
  change: DependencyChange,
  options: ComputeOptions,
): Promise<SurfaceOutcome> {
  const provider = surfaceProviderFor(change.ecosystem);
  if (!provider) {
    return unavailable(
      'none',
      'unsupported-ecosystem',
      `Drift has no computed API-surface diff for ${change.ecosystem}; this upgrade rests on prose evidence alone.`,
    );
  }

  if (!change.from || !change.to) {
    return unavailable(
      provider.tool,
      'version-unavailable',
      `${change.name} has no pair of versions to compare.`,
    );
  }

  const workdir = await mkdtemp(join(tmpdir(), 'drift-surface-'));
  try {
    return await provider.compute({
      name: change.name,
      from: change.from,
      to: change.to,
      exec: options.exec ?? execCommand,
      workdir,
      logger: options.logger,
      ...(options.env ? { env: options.env } : {}),
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(options.readRepoFile ? { readRepoFile: options.readRepoFile } : {}),
    });
  } catch (err) {
    // A provider throwing is a bug in Drift, not a fact about the dependency —
    // but it still must not take down a scan of forty other packages.
    options.logger.debug(`Surface diff crashed for ${change.name}: ${(err as Error).message}`);
    return unavailable(provider.tool, 'toolchain-failed', `Drift could not compare ${change.name}: ${(err as Error).message}`);
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export * from './types.js';
export { parseCargoPublicApi } from './rust.js';
export { moduleDirectory, resetGoSurfaceCache } from './go.js';
export * from './go-api.js';
export * from './go-toolchain.js';
export { parseJapicmp, jarUrl, parseCoordinate } from './java.js';
export { parsePythonSurface } from './python.js';
