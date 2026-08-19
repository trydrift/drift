import { readdir, readlink, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

/**
 * The layer boundary, enforced by types and by a filesystem audit rather than
 * by comment and good intentions.
 *
 * Layer C (prediction adapters) may see a `PredictionInput`. Layer D (the
 * evaluator) is the only layer that may load a `PrivateTruth`. The two are
 * kept apart three ways, deliberately redundantly, because each catches a
 * different mistake:
 *
 *   1. `PredictionInput` has no field that could carry private truth, so an
 *      adapter cannot be *handed* the answer. This catches the old
 *      `fullPipelinePrediction(fixture, adjudication)` signature.
 *   2. `PrivateTruth` is branded with a unique symbol, so it cannot be
 *      structurally widened into anything an adapter accepts even via `any`-
 *      adjacent inference. This catches an accidental refactor.
 *   3. `auditWorkspaceIsolation` walks the materialized workspace and fails on
 *      any private artifact found inside it. This is the only one of the three
 *      that still holds once a coding agent with shell access is running in
 *      that directory, which is exactly the R3 track — and it is therefore the
 *      one that actually matters.
 */

declare const privateTruthBrand: unique symbol;

/** Applied to `PrivateTruth` at its loader. Nothing in Layer C can produce or accept a branded value. */
export type Private<T> = T & { readonly [privateTruthBrand]: 'eval-private' };

export function markPrivate<T>(value: T): Private<T> {
  return value as Private<T>;
}

/**
 * A directory containing only public case material, ready to hand to a
 * prediction adapter or to mount for a coding agent. Produced solely by
 * `materializeWorkspace`, which audits it before returning.
 */
export interface PredictionWorkspace {
  /** Absolute path to the consumer checkout the adapter analyses and an agent may edit. */
  root: string;
  /** Absolute path to the frozen upstream `old`/`new` package trees. */
  upstreamOldDir: string;
  upstreamNewDir: string;
  /** Every path audited clean, for the run artifact's isolation record. */
  auditedPaths: number;
}

/**
 * Filename and directory markers that must never appear inside a prediction
 * workspace. Matched case-insensitively on the path's own segments so a
 * nested `docs/adjudication.yml` in a real consumer repository is caught too —
 * a false positive there is a fixable case-authoring problem, whereas a false
 * negative is a silently contaminated benchmark result.
 */
const PRIVATE_MARKERS: readonly RegExp[] = [
  /^adjudication\.ya?ml$/i,
  /^gold\.patch$/i,
  /^developer\.patch$/i,
  /^private-truth\.ya?ml$/i,
  /^hidden-oracles?\.ya?ml$/i,
];

const PRIVATE_DIR_MARKERS: readonly RegExp[] = [/^reviews$/i, /^private$/i, /^expected$/i, /^judgements$/i];

export class WorkspaceIsolationError extends Error {
  readonly offendingPaths: readonly string[];

  constructor(offendingPaths: readonly string[]) {
    super(
      `Prediction workspace contains private benchmark material and cannot be used:\n  ${offendingPaths.join('\n  ')}`,
    );
    this.name = 'WorkspaceIsolationError';
    this.offendingPaths = offendingPaths;
  }
}

/**
 * Walks a workspace and throws if any private artifact is reachable from it.
 *
 * Also rejects a workspace that is inside, or that contains, the private case
 * root: a materialization that copied the consumer to the wrong place would
 * otherwise pass a name-based check while sitting one `../` away from every
 * answer. Symlinks are resolved for the same reason — a link out of the
 * workspace is the obvious way to defeat a name check.
 */
export async function auditWorkspaceIsolation(workspaceRoot: string, privateRoot: string): Promise<number> {
  const root = resolve(workspaceRoot);
  const forbiddenRoot = resolve(privateRoot);
  const offending: string[] = [];
  // Symlink comparison happens in real-path space: on macOS the temp root is
  // itself a symlink (`/var` -> `/private/var`), so a link that never leaves
  // the workspace would otherwise look like an escape.
  const realRoot = await realpath(root).catch(() => root);

  if (root === forbiddenRoot || isInside(root, forbiddenRoot) || isInside(forbiddenRoot, root)) {
    offending.push(`${root} overlaps the private case root ${forbiddenRoot}`);
  }

  let audited = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      audited += 1;

      if (entry.isSymbolicLink()) {
        // The link's *target*, not the link itself: a name-based check is
        // trivially defeated by `ln -s ../../private shortcut`, which is the
        // single most likely way a workspace stops being isolated.
        const target = await readlink(path)
          .then((value) => realpath(resolve(dir, value)))
          .catch(() => null);
        if (target && !isInside(target, realRoot) && target !== realRoot) {
          offending.push(`${path} links outside the workspace`);
        }
        continue;
      }

      if (entry.isDirectory()) {
        if (PRIVATE_DIR_MARKERS.some((marker) => marker.test(entry.name))) offending.push(path);
        else if (entry.name !== 'node_modules' && entry.name !== '.git') await walk(path);
        continue;
      }

      if (PRIVATE_MARKERS.some((marker) => marker.test(entry.name))) offending.push(path);
    }
  };

  await walk(root);

  if (offending.length > 0) throw new WorkspaceIsolationError(offending.sort());
  return audited;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith('..') && !rel.startsWith(`..${sep}`);
}
