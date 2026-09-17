# controller-pilot-* — exploratory, never pooled

`controller-pilot-winston`, `controller-pilot-ethereum` and `controller-pilot-eslint` ran `generic-orchestrated` and `drift-orchestrated` once each on the three development cases, before the development experiment, to find product defects on real repositories. They ran at an earlier product commit and every defect they exposed was fixed in #323 before the development run, so none of these trials describes the product that was measured.

Defects found and fixed in #323:

- **Installed dependencies patched (winston, Drift).** A repair session edited `node_modules/logform/index.d.ts`. Git ignores it, the controller's compile passed, and the hidden validator's fresh install failed. Protected globs (`node_modules/**`) matched one directory level only, which let that file into the repair's scope. Now: dependency writes are detected, a session without a manifest change is rejected, the tree is reinstalled clean; globs use the shared matcher.
- **Repository commit hooks (ESLint, both conditions).** husky refused the harness's commit (generic trial excluded as `runner_error`) and the controller's commit of a 5.9M-token repair session, which was then reset. Remediation commits now skip hooks.
- **Baseline could not install (ESLint).** `npm install` failed with ERESOLVE at the pre-upgrade commit, so pre-existing failures reached an agent. npm peer conflicts are retried with `--legacy-peer-deps`.
- **Junk repair scope (ESLint).** `Node.js` and stack-frame fragments became allowed files. Output-derived paths must exist.
- **Agents ran broad verification despite the prompt** (every trial: 5–10 whole-project `tsc`/lint runs per session). Controller-verified sessions now run with a PreToolUse guard that refuses broad checks.

## Second pilot: `controller-pilot2-*` and `controller-smoke-2`

Ran after the fixes above, with the verification guard on (ethereumjs and ESLint, both orchestrated conditions). Still exploratory: it exposed one more defect, fixed in #323 before the development run.

- **Baselines measured nothing (ESLint).** The pre-upgrade worktree lived under `.git/`; Jest ignores paths containing `.git` ("No files found") and ESLint loaded the enclosing repository's config. No pre-existing failure was subtracted, so both conditions sent macOS-only docker-manager failures to repair sessions (the generic trial ended `no-progress` on them although the validator passed it). Baseline and fix worktrees now live in the temp directory; on the ESLint workspace the baseline reports exactly the three pre-existing failures.

What it showed about the architecture (n = 1 per cell, never pooled): with the guard, agents issued few broad checks but many narrow ones and read the dependency's source repeatedly in each fresh session; gross input was 8.3M/9.7M (generic/Drift, ethereumjs, both succeeded) and 11.7M/10.3M (ESLint; Drift timed out), against v3 raw medians of about 6M and 7M.
