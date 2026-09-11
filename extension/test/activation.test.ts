import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as vscode from 'vscode';
import { activate } from '../src/extension.js';
import { Uri, window, workspace } from './vscode-stub.js';

/**
 * Activation must not wait on the first run.
 *
 * VS Code resolves a contributed view only once its extension has finished
 * activating, so everything `activate` awaits is time the Drift panel spends
 * blank. The first run is open-ended by nature: it walks the repository,
 * analyses the change, and ends on a notification whose promise settles only
 * when somebody clicks it — and a notification that has hidden itself in the
 * notification centre is never clicked. A panel that waited on all of that
 * stayed blank for as long as nobody answered a toast, which in a freshly
 * opened Codespace was indefinitely.
 *
 * The test stands in for "anything at startup that never finishes" by making
 * every workspace read hang, and asks only that `activate` returns anyway, with
 * the panel's provider in place.
 */

class MemoryMemento {
  private readonly values = new Map<string, unknown>();
  readonly keys = () => [...this.values.keys()];
  get<T>(key: string, fallback?: T): T {
    return (this.values.has(key) ? this.values.get(key) : fallback) as T;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

test('activation returns while the first run is still in progress', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'drift-activation-'));
  const storage = mkdtempSync(join(tmpdir(), 'drift-activation-storage-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Drift', '-c', 'user.email=drift@example.invalid', 'commit', '--allow-empty', '-q', '-m', 'init'], {
    cwd: repo,
  });

  const savedFs = { ...workspace.fs };
  const savedFolders = workspace.workspaceFolders;
  const never = () => new Promise<never>(() => undefined);
  workspace.workspaceFolders = [{ uri: Uri.file(repo) }];
  Object.assign(workspace.fs, { readFile: never, readDirectory: never, stat: never });

  const context = {
    subscriptions: [] as { dispose(): unknown }[],
    extensionUri: Uri.file(join(__dirname, '..')),
    globalStorageUri: Uri.file(storage),
    workspaceState: new MemoryMemento(),
    extension: { packageJSON: { version: '0.0.0-test' } },
  } as unknown as vscode.ExtensionContext;

  let timer: NodeJS.Timeout | undefined;
  try {
    const outcome = await Promise.race([
      activate(context).then(() => 'returned'),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('still waiting'), 3000);
      }),
    ]);

    assert.equal(outcome, 'returned', 'activate must not wait for the first run to finish');
    assert.ok(window.__webviewViewProviders.has('drift.changes'), 'the panel has a provider to resolve it with');
  } finally {
    clearTimeout(timer);
    for (const disposable of context.subscriptions) disposable.dispose();
    Object.assign(workspace.fs, savedFs);
    workspace.workspaceFolders = savedFolders;
    rmSync(repo, { recursive: true, force: true });
    rmSync(storage, { recursive: true, force: true });
  }
});
