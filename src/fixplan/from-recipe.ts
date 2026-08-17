import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BreakingChange, DependencyChange } from '../types.js';
import type { CommunityRecipeCandidate } from '../remediation/types.js';
import { executeCommunityRecipe } from '../remediation/execute-recipe.js';
import { execCommand, type Exec } from '../util/exec.js';
import type { Logger } from '../util/logger.js';
import { buildPlan } from './author.js';
import { inferOps, type ObservedEdit } from './infer.js';
import type { FixPlan } from './schema.js';

/**
 * Turn a community recipe into a candidate fix plan by watching what it does.
 *
 * A recipe is third-party code, and the previous design ran it, scope-checked
 * the files it touched, and committed the result. Scope-checking answers "did
 * it stay in its lane". It does not answer "is this the right edit" — and a
 * pipeline that demanded a model prove its rule while asking a third-party
 * program for nothing had the trust backwards.
 *
 * So the recipe now runs in a throwaway worktree purely as a *source of
 * suggestions*. Drift reads the before/after pairs it produced, infers which
 * of its own operations would explain them (`infer.ts`), and puts the result
 * through the same gate a model-authored plan goes through. What eventually
 * reaches the repository is Drift's own ops, applied by Drift's own executor,
 * anchored to Drift's own localized impact sites. The recipe's output is
 * discarded along with the worktree.
 *
 * This is strictly less than recipes could do before, and deliberately: a
 * recipe whose edits Drift cannot re-derive is a recipe Drift cannot
 * describe in a plan document, and an indescribable deterministic fix is
 * exactly the thing this whole tier exists to stop shipping.
 */

export interface RecipeInferenceOptions {
  candidate: CommunityRecipeCandidate;
  change: BreakingChange;
  dependencyChange?: DependencyChange;
  /**
   * A clean, disposable worktree checked out at the analysed commit. The
   * caller owns its creation and removal — this function never writes
   * outside it and never touches the developer's checkout.
   */
  sandbox: string;
  /** Files whose recipe edits are worth reading: the ones localization found sites in. */
  relevantFiles: ReadonlySet<string>;
  exec?: Exec;
  logger: Logger;
}

export async function fixPlanFromRecipe(options: RecipeInferenceOptions): Promise<FixPlan | null> {
  const { candidate, change, sandbox, relevantFiles, logger } = options;
  const exec = options.exec ?? execCommand;

  const result = await executeCommunityRecipe(candidate, sandbox, { exec, logger });
  if (result.status !== 'applied' || result.changedFiles.length === 0) {
    logger.debug(`${candidate.name}@${candidate.version} changed nothing Drift could learn a rule from.`);
    return null;
  }

  const edits: ObservedEdit[] = [];
  let sawUnreadableChange = false;

  for (const file of result.changedFiles) {
    // A recipe is free to edit files this finding never reached. Drift is not
    // free to learn a rule from them: the plan will only ever be applied at
    // this finding's own localized sites, so an op inferred from an unrelated
    // file would be an op with nowhere legitimate to fire.
    if (!relevantFiles.has(file)) {
      sawUnreadableChange = true;
      continue;
    }

    const pair = await readPair(sandbox, file, exec);
    if (!pair) {
      sawUnreadableChange = true;
      continue;
    }

    const before = pair.before.split('\n');
    const after = pair.after.split('\n');

    // Every op Drift executes is line-preserving. A recipe that added or
    // removed lines did something outside the vocabulary by definition, and
    // pretending otherwise would misalign every subsequent line.
    if (before.length !== after.length) {
      logger.debug(`${candidate.name} changed the line count of ${file}; that is not expressible as a Drift operation.`);
      return null;
    }

    for (let i = 0; i < before.length; i++) {
      if (before[i] !== after[i]) {
        edits.push({ file, lineNumber: i + 1, before: before[i]!, after: after[i]! });
      }
    }
  }

  if (edits.length === 0) {
    logger.debug(`${candidate.name}@${candidate.version} touched no file this finding reaches.`);
    return null;
  }

  const inference = inferOps(edits);
  if (inference.ops.length === 0 || inference.unexplained.length > 0) {
    logger.info(
      `Drift could not re-derive what ${candidate.name}@${candidate.version} did to ${inference.unexplained.length || edits.length} line(s), so it will not apply it. This finding falls through to an agent.`,
    );
    return null;
  }

  if (sawUnreadableChange) {
    logger.info(
      `${candidate.name}@${candidate.version} also changed files outside this finding's call sites; those edits were not learned from and will not be applied.`,
    );
  }

  return buildPlan({
    change,
    dependencyChange: options.dependencyChange,
    migration: candidate.migration,
    rationale: `Inferred from ${edits.length} edit(s) made by ${candidate.name}@${candidate.version} in an isolated worktree, then re-derived as Drift operations. The recipe's own output was discarded.`,
    citations: [],
    ops: inference.ops,
    provenance: {
      author: 'recipe',
      recipe: {
        name: candidate.name,
        version: candidate.version,
        publisher: candidate.publisher,
        source: candidate.source,
      },
      authoredAt: new Date().toISOString(),
    },
  });
}

/** The file as committed, and as the recipe left it. */
async function readPair(
  sandbox: string,
  file: string,
  exec: Exec,
): Promise<{ before: string; after: string } | null> {
  const committed = await exec('git', ['show', `HEAD:${file}`], { cwd: sandbox });
  if (committed.code !== 0) return null;

  try {
    return { before: committed.stdout, after: await readFile(join(sandbox, file), 'utf8') };
  } catch {
    return null;
  }
}
