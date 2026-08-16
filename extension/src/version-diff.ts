import * as vscode from 'vscode';
import { join } from 'node:path';
import { execCommand, type Exec } from '../../src/util/exec.js';
import { fetchVersionDiff, type VersionDiffFile } from '../../src/evidence/version-diff.js';
import { envWithShellPath } from './shell-path.js';

/**
 * The one piece of evidence Drift shows that is a claim about the package
 * rather than an observation of it — the semver heuristic — gets a real
 * answer here: what actually changed between the two published versions,
 * opened the way VS Code opens every other diff.
 *
 * Nothing is rendered inside the webview. A diff of even a small package is
 * more than a panel can show without becoming the thing it's supposed to
 * summarise, so this hands the two extracted trees straight to the editor's
 * own diff view (`vscode.diff` for one file, the multi-file "changes" view
 * for more) and lets it do what it already does better than a webview could.
 */

const EMPTY_SCHEME = 'drift-version-diff-empty';
let providerRegistered = false;

function ensureEmptyContentProvider(): void {
  if (providerRegistered) return;
  providerRegistered = true;
  vscode.workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, {
    // Only ever used for the side of an added/removed file that never
    // existed — an empty document is the correct diff base, not a stand-in
    // for content Drift could not fetch.
    provideTextDocumentContent: () => '',
  });
}

const MAX_DIFF_FILES = 50;

export async function openPackageVersionDiff(args: {
  ecosystem: string;
  name: string;
  from: string;
  to: string;
  output?: vscode.LogOutputChannel;
}): Promise<void> {
  ensureEmptyContentProvider();

  const label = `${args.name} ${args.from} → ${args.to}`;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Drift: fetching ${label}…` },
    async () => {
      // The same PATH-corrected environment every other exec in the extension
      // uses — `tar` and `git` are usually on the system PATH regardless, but
      // a GUI-launched VS Code should not see a different `git` than the
      // terminal a developer would run this same diff from by hand.
      const env = await envWithShellPath();
      const exec: Exec = (command, cmdArgs, options) => execCommand(command, cmdArgs, { ...options, env });

      const result = await fetchVersionDiff({
        ecosystem: args.ecosystem,
        name: args.name,
        from: args.from,
        to: args.to,
        exec,
      });

      if (!result.available) {
        args.output?.warn(`Drift: could not diff ${label}: ${result.reason}`);
        await vscode.window.showWarningMessage(`Drift: ${result.reason}`);
        return;
      }

      if (result.files.length === 0) {
        await vscode.window.showInformationMessage(`Drift: ${label} — no textual difference between the two releases.`);
        return;
      }

      const shown = result.files.slice(0, MAX_DIFF_FILES);
      if (result.truncated || result.files.length > MAX_DIFF_FILES) {
        args.output?.info(
          `Drift: ${label} changed ${result.files.length} files; showing the first ${shown.length}.`,
        );
      }

      const resources = shown.map((file) => resourcePair(result.beforeDir, result.afterDir, file));

      if (resources.length === 1) {
        const [only] = resources;
        if (only) {
          await vscode.commands.executeCommand('vscode.diff', only[0], only[1], `${label} — ${only[2]}`, {
            preview: true,
          } satisfies vscode.TextDocumentShowOptions);
        }
        return;
      }

      try {
        await vscode.commands.executeCommand(
          'vscode.changes',
          label,
          resources.map(([before, after]) => [after, before, after]),
        );
      } catch (err) {
        // Older VS Code builds without the multi-diff editor: fall back to
        // opening the single most-likely-relevant file rather than nothing.
        args.output?.warn(`Drift: multi-file diff unavailable (${(err as Error).message}); opening one file.`);
        const [first] = resources;
        if (first) {
          await vscode.commands.executeCommand('vscode.diff', first[0], first[1], `${label} — ${first[2]}`, {
            preview: true,
          } satisfies vscode.TextDocumentShowOptions);
        }
      }
    },
  );
}

/** [before, after, path] — real files on disk for either side that exists, an empty virtual document otherwise. */
function resourcePair(
  beforeDir: string,
  afterDir: string,
  file: VersionDiffFile,
): [vscode.Uri, vscode.Uri, string] {
  const emptyUri = vscode.Uri.parse(`${EMPTY_SCHEME}:/${encodeURIComponent(file.path)}`);
  const before = file.status === 'added' ? emptyUri : vscode.Uri.file(join(beforeDir, file.path));
  const after = file.status === 'removed' ? emptyUri : vscode.Uri.file(join(afterDir, file.path));
  return [before, after, file.path];
}
