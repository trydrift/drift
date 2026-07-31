import type * as vscode from 'vscode';
import type { ThreadItem } from './session.js';

/**
 * Past conversations.
 *
 * Every other agent panel in this editor keeps its history, and a developer who
 * has used one expects the same here: the scan you ran on Tuesday, the fix you
 * abandoned half way, the answer you want to read again. Losing all of that
 * because you pressed "new chat" is the kind of small betrayal that stops people
 * pressing it at all — and then the panel accumulates one endless thread.
 *
 * Stored per workspace, because a conversation is about a repository. Trimmed to
 * a fixed number of entries: this is a `Memento`, which is a JSON blob VS Code
 * loads on every startup, not a database.
 */

export interface HistoryEntry {
  id: string;
  title: string;
  /** Epoch milliseconds. */
  at: number;
  /** Rough size, for the list's second line. */
  messages: number;
  items: ThreadItem[];
}

const KEY = 'drift.history';
const LIMIT = 40;

export class DriftHistory {
  constructor(private readonly memento: vscode.Memento) {}

  list(): HistoryEntry[] {
    return (this.memento.get<HistoryEntry[]>(KEY, []) ?? []).slice().sort((a, b) => b.at - a.at);
  }

  get(id: string): HistoryEntry | undefined {
    return this.list().find((entry) => entry.id === id);
  }

  /**
   * Write a conversation down, replacing any earlier save of the same one.
   *
   * Called both when a conversation is put away and, debounced, while it is
   * live — so a crash or a window reload costs nothing.
   */
  async save(entry: { id: string; title: string; items: readonly ThreadItem[] }): Promise<void> {
    // A transcript with nothing in it is not a conversation, and saving one
    // would fill the list with entries nobody can tell apart.
    if (entry.items.length === 0) return;

    const rest = this.list().filter((existing) => existing.id !== entry.id);
    const record: HistoryEntry = {
      id: entry.id,
      title: entry.title,
      at: Date.now(),
      messages: entry.items.filter((item) => item.kind === 'user' || item.kind === 'assistant').length,
      items: [...entry.items],
    };

    await this.memento.update(KEY, [record, ...rest].slice(0, LIMIT));
  }

  async remove(id: string): Promise<void> {
    await this.memento.update(
      KEY,
      this.list().filter((entry) => entry.id !== id),
    );
  }

  async clear(): Promise<void> {
    await this.memento.update(KEY, []);
  }
}

/** Ids are only ever compared, never parsed. */
export function newConversationId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** "3 minutes ago" beats a timestamp in a list you are scanning. */
export function describeWhen(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'just now';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;

  return new Date(at).toLocaleDateString();
}
