import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execCommand, type Exec } from '../../src/util/exec.js';
import { fetchVersionDiff, type VersionDiffFile } from '../../src/evidence/version-diff.js';
import { envWithShellPath } from './shell-path.js';
import { diffHunks, splitLines } from './diff.js';
import { extensionForLanguage } from './ui/highlight.js';

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

/* ------------------------------------------------------------------ */
/* One change, on its own                                              */
/* ------------------------------------------------------------------ */

/**
 * The diff for a *single* finding, rather than for the whole release.
 *
 * A before/after pair in the panel raises exactly one question — show me that,
 * properly — and answering it by opening every file that changed between two
 * releases buries the answer in a few hundred unrelated ones. So this opens
 * the same two sides the panel is showing, in the editor's own diff view,
 * where they get real syntax highlighting, real navigation, and the reader's
 * own diff settings.
 *
 * Where the package's published source can be fetched, the two sides are
 * widened from the bare declaration to the surrounding lines of the file the
 * symbol actually lives in — the same change, with enough context around it to
 * read. Where it cannot (an ecosystem with no fetchable source, an offline
 * editor), the declarations themselves are still a complete answer to the
 * question asked, so they are shown alone rather than not at all.
 */
export interface ChangeDiffRequest {
  /** The declaration as it was, and as it now is. */
  before: string;
  after: string;
  /** What the diff editor is titled — usually the symbol, or the package. */
  title: string;
  /** Shiki language id; decides the extension the two sides are named with. */
  language?: string;
  /** The symbol to look for when locating this change in the published source. */
  symbol?: string;
  /** Package coordinates, when the real source can be fetched to add context. */
  source?: { ecosystem: string; name: string; from: string; to: string };
}

const SNIPPET_SCHEME = 'drift-change-diff';
/** Lines of surrounding source kept on either side of the located change. */
const CONTEXT_LINES = 12;
/** Files read while looking for the symbol, before giving up and showing the declarations alone. */
const MAX_SEARCHED_FILES = 400;
/** Files read at once while searching. See the loop in `locateInSource`. */
const LOCATE_BATCH = 16;

const snippets = new Map<string, string>();
let snippetProviderRegistered = false;

function ensureSnippetProvider(): void {
  if (snippetProviderRegistered) return;
  snippetProviderRegistered = true;
  vscode.workspace.registerTextDocumentContentProvider(SNIPPET_SCHEME, {
    provideTextDocumentContent: (uri) => snippets.get(uri.path) ?? '',
  });
}

export async function openChangeDiff(
  request: ChangeDiffRequest,
  output?: vscode.LogOutputChannel,
): Promise<void> {
  ensureSnippetProvider();

  const extension = extensionForLanguage(request.language ?? 'typescript');
  // A notification, not a window-bar message, and cancellable. Widening the
  // declarations with real surrounding source means downloading and extracting
  // two published versions of the package, which on a large one is tens of
  // seconds — and the status-bar spinner this used to show was invisible
  // enough that pressing "View diff" read as a button that did nothing at all.
  // Cancelling falls back to the declarations, which were always a complete
  // answer to the question the pair is asking.
  const located = request.source
    ? await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Drift: fetching ${request.source.name} ${request.source.from} and ${request.source.to} to show ${request.title} in context…`,
          cancellable: true,
        },
        (_progress, token) => locateInSource(request, output, token),
      )
    : null;

  const before = located?.before ?? request.before;
  const after = located?.after ?? request.after;
  const name = located?.path ?? `${slug(request.title)}.${extension}`;
  const title = located ? `${request.title} — ${located.path}` : request.title;

  // Keyed by content as well as name so two different findings in the same
  // file never collide on one virtual document, and so re-opening the same
  // finding reuses the tab it already has.
  const beforeUri = snippetUri('before', name, before);
  const afterUri = snippetUri('after', name, after);

  output?.info(`Drift: opening the diff for ${title}`);
  // Explicit rather than left to default to "whichever group is active":
  // the click that requested this came from a sidebar webview, which is never
  // itself an editor group, and leaving the target unstated risked the new tab
  // landing wherever VS Code's own notion of "active" happened to resolve to
  // instead of somewhere the developer would actually see it open.
  await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, title, {
    preview: true,
    viewColumn: vscode.ViewColumn.One,
  } satisfies vscode.TextDocumentShowOptions);
}

function snippetUri(side: 'before' | 'after', name: string, content: string): vscode.Uri {
  const path = `/${side}/${hash(content)}/${name}`;
  snippets.set(path, content);
  return vscode.Uri.from({ scheme: SNIPPET_SCHEME, path });
}

/**
 * Find where this change lives in the published source, and return that region
 * of both versions.
 *
 * `null` whenever the answer would be a guess: an ecosystem whose source
 * cannot be fetched, a symbol that appears in no changed file, a network that
 * is not there. The caller falls back to the declarations the panel already
 * has, which are correct — just narrower.
 */
async function locateInSource(
  request: ChangeDiffRequest,
  output?: vscode.LogOutputChannel,
  token?: vscode.CancellationToken,
): Promise<{ before: string; after: string; path: string } | null> {
  const source = request.source;
  const symbol = request.symbol?.trim();
  if (!source || !symbol) return null;

  try {
    output?.info(`Drift: fetching ${source.name} ${source.from} and ${source.to} to locate ${symbol}`);
    const env = await envWithShellPath();
    const exec: Exec = (command, args, options) => execCommand(command, args, { ...options, env });
    const result = await fetchVersionDiff({ ...source, exec });
    if (token?.isCancellationRequested) return null;
    if (!result.available) {
      output?.info(`Drift: showing the declaration alone for ${request.title}: ${result.reason}`);
      return null;
    }

    // Only files that changed on both sides can contain a before *and* an
    // after; an added or removed file has nothing to compare the symbol
    // against. Files whose own name mentions the symbol are tried first,
    // which in practice is where a top-level export lives.
    const candidates = result.files
      .filter((file) => file.status === 'modified')
      .sort((a, b) => Number(mentions(b.path, symbol)) - Number(mentions(a.path, symbol)))
      .slice(0, MAX_SEARCHED_FILES);

    const word = symbolPattern(symbol);

    // Read in batches rather than one file at a time. The files are already
    // ordered best-guess-first, so the batch is kept small: the common case is
    // a hit in the first few, and reading four hundred files to find one that
    // was going to be second is its own kind of slow.
    for (let i = 0; i < candidates.length; i += LOCATE_BATCH) {
      if (token?.isCancellationRequested) return null;

      const batch = candidates.slice(i, i + LOCATE_BATCH);
      const texts = await Promise.all(
        batch.map(async (file) => ({
          file,
          before: await readFile(join(result.beforeDir, file.path), 'utf8').catch(() => null),
          after: await readFile(join(result.afterDir, file.path), 'utf8').catch(() => null),
        })),
      );

      // Scanned in the batch's own order, not completion order, so the answer
      // does not depend on which read happened to finish first.
      for (const { file, before: beforeText, after: afterText } of texts) {
        if (beforeText === null || afterText === null) continue;
        if (!word.test(beforeText) && !word.test(afterText)) continue;

        const hunk = diffHunks(beforeText, afterText).find(
          (candidate) =>
            candidate.baselineLines.some((line) => word.test(line)) ||
            candidate.modifiedLines.some((line) => word.test(line)),
        );
        if (!hunk) continue;

        return {
          before: slice(beforeText, hunk.baselineStart, hunk.baselineEnd),
          after: slice(afterText, hunk.start, hunk.end),
          path: file.path,
        };
      }
    }

    output?.info(
      `Drift: ${symbol} did not appear in any file that changed between ${source.name} ${source.from} and ${source.to}; showing the declaration alone.`,
    );
    return null;
  } catch (err) {
    output?.warn(`Drift: could not locate ${request.title} in the published source: ${(err as Error).message}`);
    return null;
  }
}

function slice(text: string, start: number, end: number): string {
  const lines = splitLines(text);
  return lines.slice(Math.max(0, start - CONTEXT_LINES), Math.min(lines.length, end + CONTEXT_LINES)).join('\n');
}

/** The symbol as a whole word — `Drop` must not match `Dropdown`. */
function symbolPattern(symbol: string): RegExp {
  const bare = symbol.split(/[.#:]/).pop() ?? symbol;
  return new RegExp(`(^|[^\\w$])${bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w$])`);
}

function mentions(path: string, symbol: string): boolean {
  const bare = (symbol.split(/[.#:]/).pop() ?? symbol).toLowerCase();
  return bare.length > 2 && path.toLowerCase().includes(bare);
}

/** A filename-safe stand-in for a title, so the diff tab reads as a file. */
function slug(title: string): string {
  const cleaned = title.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.slice(0, 60) || 'change';
}

/** Enough to key one snippet apart from another; not a security boundary. */
function hash(text: string): string {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193);
  }
  return (value >>> 0).toString(36);
}

export async function openPackageVersionDiff(args: {
  ecosystem: string;
  name: string;
  from: string;
  to: string;
  output?: vscode.LogOutputChannel;
}): Promise<void> {
  ensureEmptyContentProvider();

  const label = `${args.name} ${args.from} → ${args.to}`;
  args.output?.info(`Drift: fetching ${label} to build a diff`);
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
          args.output?.info(`Drift: opening the diff for ${label} — ${only[2]}`);
          await vscode.commands.executeCommand('vscode.diff', only[0], only[1], `${label} — ${only[2]}`, {
            preview: true,
            viewColumn: vscode.ViewColumn.One,
          } satisfies vscode.TextDocumentShowOptions);
        }
        return;
      }

      try {
        args.output?.info(`Drift: opening a ${resources.length}-file diff for ${label}`);
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
            viewColumn: vscode.ViewColumn.One,
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
