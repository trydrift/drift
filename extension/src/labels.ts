import type { SessionMode, SessionPermission } from './session.js';

/**
 * Human-readable names for the composer settings.
 *
 * Kept apart from `session.ts` so the render layer never has to import `vscode`.
 * That is not a stylistic preference: it means the whole panel can be rendered
 * and checked in plain Node, which is the only way this much markup gets tested
 * at all.
 */

export function describeMode(mode: SessionMode): string {
  return mode === 'ask' ? 'Ask' : 'Agent';
}

export function describePermission(permission: SessionPermission): string {
  switch (permission) {
    case 'ask':
      return 'Ask first';
    case 'auto-edit':
      return 'Edit, then review';
    case 'full-auto':
      return 'Edit and commit';
  }
}

/**
 * The same setting, named for a toolbar rather than a sentence.
 *
 * The composer bar is a few hundred pixels wide in a sidebar, and "Edit, then
 * review" pushes every other control off the row. The long form still shows in
 * the button's tooltip and in the quick pick, where there is room for it.
 */
export function describePermissionShort(permission: SessionPermission): string {
  switch (permission) {
    case 'ask':
      return 'Ask';
    case 'auto-edit':
      return 'Review';
    case 'full-auto':
      return 'Auto';
  }
}

/** What each permission actually allows, for the quick pick's detail line. */
export function explainPermission(permission: SessionPermission): string {
  switch (permission) {
    case 'ask':
      return 'The agent asks before touching a file';
    case 'auto-edit':
      return 'The agent edits, then waits for you to keep or undo each change';
    case 'full-auto':
      return 'The agent edits and commits each group on its own';
  }
}

/** What each mode is allowed to do. */
export function explainMode(mode: SessionMode): string {
  return mode === 'ask'
    ? 'Analyse and explain. Nothing on disk changes.'
    : 'Analyse, then let your AI agent edit the affected files.';
}
