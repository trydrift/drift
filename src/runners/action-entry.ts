/**
 * Thin executable wrapper for the GitHub Action.
 *
 * Kept separate from `action.ts` so that module's `runAction` stays importable
 * and testable without triggering a process exit as a side effect of the import.
 */
import { runAction } from './action.js';

runAction().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.log(`::error::Drift crashed: ${(err as Error).message}`);
    process.exitCode = 1;
  },
);
