import type { SessionEffort, SessionMode, SessionPermission } from './session.js';

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

export function describeEffort(effort: SessionEffort): string {
  return effort === 'quick' ? 'Quick' : effort === 'thorough' ? 'Thorough' : 'Balanced';
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
