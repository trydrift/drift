/**
 * Re-exported from `src/upgrade/severity.ts`, which is deliberately
 * dependency-free (no `vscode`, no imports at all) so it can be shared
 * verbatim between the extension's render layer and the CLI's `drift
 * outdated` — both need the exact same "how much should a developer care"
 * verdict for the exact same candidate.
 */
export * from '../../src/upgrade/severity.js';
