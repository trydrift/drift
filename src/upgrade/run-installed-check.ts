import { resolve } from 'node:path';

import { nodeWorkspaceFs } from '../detect/workspace.js';
import { buildIndex } from '../index/metarag.js';
import { walkSourceFiles } from '../index/walk.js';
import { checkInstalled, type InstalledCheckResult, type PackageOutcome } from './installed-check.js';
import { directDependencies, discoverTargets } from './scan.js';

/**
 * The installed-code check, assembled once and shared by every surface.
 *
 * Deliberately *not* routed through `scanUpgrades`. That pipeline answers an
 * upgrade question — it resolves registry versions, diffs published pairs,
 * localizes impact, optionally installs and builds — and none of that is
 * needed to ask whether the code matches what is already on disk. Routing this
 * through it would make a local check pay for a full network scan, and would
 * drop every dependency already at its latest version, which is precisely
 * where "am I already broken?" is most worth asking.
 *
 * So the inputs are gathered directly: the manifests say what is installed,
 * the walk says what the code imports, and the check compares them.
 */
export interface InstalledCheckRunRequest {
  /** Repository root. */
  directory: string;
  /** Restrict the check to one package. */
  only?: string | undefined;
  /** Include dev/optional/peer dependencies. Default true. */
  includeDev?: boolean;
}

export interface InstalledCheckRun extends InstalledCheckResult {
  /** Dependencies skipped because no lockfile pins what is actually installed. */
  assumedSkipped: number;
  /** Files walked, so a caller can say how much of the repository was read. */
  filesRead: number;
  /**
   * Whether the walk read all of the source it found.
   *
   * A clean result means "every name you import exists" — a claim about
   * absence, and absence is only as good as the search behind it. A walk that
   * hit its file ceiling or skipped oversized source did not read everything,
   * and saying so is the difference between a finding and an overclaim.
   */
  sourceComplete: boolean;
}

export async function runInstalledCheck(request: InstalledCheckRunRequest): Promise<InstalledCheckRun> {
  const root = resolve(request.directory);
  const fs = nodeWorkspaceFs();

  // Both halves are independent: one reads manifests, the other reads source.
  const [{ targets }, walked] = await Promise.all([
    discoverTargets(root, [''], new Map(), fs),
    walkSourceFiles(root),
  ]);

  const installed = new Map<string, { version: string | null; ecosystem: string }>();
  let assumedSkipped = 0;

  for (const target of targets) {
    const { dependencies } = await directDependencies(root, target, request.includeDev ?? true, fs);
    for (const dependency of dependencies) {
      // `assumed` means the version was inferred from the declared range
      // because nothing pinned it — what a fresh install *would* get, not what
      // is on disk. This check is about the code against what it actually has,
      // so an assumption is not an answer and the dependency is skipped.
      if (dependency.assumed) {
        assumedSkipped += 1;
        continue;
      }
      if (installed.has(dependency.name)) continue;
      installed.set(dependency.name, {
        version: dependency.current === 'unspecified' ? null : dependency.current,
        ecosystem: target.manager.ecosystem,
      });
    }
  }

  const result = await checkInstalled({
    index: buildIndex(walked),
    contents: new Map(walked.map((file) => [file.path, file.content])),
    installed,
    ...(request.only ? { only: request.only } : {}),
  });

  const coverage = walked.coverage;
  return {
    ...result,
    assumedSkipped,
    filesRead: walked.length,
    sourceComplete: !coverage.sourceTruncated && coverage.oversizedSourceSkipped === 0,
  };
}

/**
 * The result in words, for a reader who is not looking at a terminal.
 *
 * Shared by the CLI, the MCP tool, the Action and the extension so that all
 * four say the same thing — and so that the one sentence that matters most,
 * what was *not* checked, cannot be dropped by one of them.
 */
export function renderInstalledCheck(run: InstalledCheckRun): string {
  const lines: string[] = [];

  if (run.missing.length === 0) {
    lines.push(
      run.checkedPackages === 0
        ? 'Nothing could be checked against its installed version.'
        : `Every name imported from ${run.checkedPackages} package${run.checkedPackages === 1 ? '' : 's'} exists in the version installed.` +
            // A clean result is a claim about absence, and absence is only as
            // good as the search behind it.
            (run.sourceComplete ? '' : ' Some source was not read, so this is not a complete answer.'),
    );
  } else {
    const files = new Set(run.missing.map((entry) => entry.file)).size;
    lines.push(
      `${run.missing.length} import${run.missing.length === 1 ? '' : 's'} in ${files} file${files === 1 ? '' : 's'} ` +
        `name${run.missing.length === 1 ? 's' : ''} something the installed version does not export.`,
      '',
    );
    for (const entry of run.missing) {
      lines.push(
        `  ${entry.file}:${entry.line}  ${entry.symbol}  —  not exported by ${entry.packageName}@${entry.installedVersion}`,
      );
    }
  }

  // Always stated, never only on failure: a clean result means "every name you
  // import exists", and the reader is entitled to know how much that covered.
  lines.push('');
  lines.push(
    `Checked ${run.checkedPackages} package${run.checkedPackages === 1 ? '' : 's'} against ${run.filesRead} file${run.filesRead === 1 ? '' : 's'}.` +
      (run.uncheckedPackages > 0 ? ` ${run.uncheckedPackages} could not be checked.` : ''),
  );
  if (run.assumedSkipped > 0) {
    lines.push(
      `${run.assumedSkipped} dependenc${run.assumedSkipped === 1 ? 'y was' : 'ies were'} skipped: no lockfile pins what is installed, ` +
        'so there is no installed version to check against.',
    );
  }

  const unchecked = run.packages.filter((entry): entry is PackageOutcome & { unchecked: NonNullable<PackageOutcome['unchecked']> } =>
    Boolean(entry.unchecked) && entry.unchecked!.reason !== 'no-imports',
  );
  if (unchecked.length > 0) {
    lines.push('');
    lines.push('Not checked:');
    for (const entry of unchecked.slice(0, 20)) {
      lines.push(`  ${entry.packageName}  —  ${entry.unchecked.detail}`);
    }
    if (unchecked.length > 20) lines.push(`  …and ${unchecked.length - 20} more.`);
  }

  lines.push('');
  lines.push(
    'This compares the names your code imports against the API of the version on disk. ' +
      'It does not follow member access through an imported object, so a clean result means every name you ' +
      'import exists — not that your use of the package is correct.',
  );

  return lines.join('\n');
}
