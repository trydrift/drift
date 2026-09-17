# controller-pilot-* — exploratory, never pooled

`controller-pilot-winston`, `controller-pilot-ethereum` and `controller-pilot-eslint` ran `generic-orchestrated` and `drift-orchestrated` once each on the three development cases, before the development experiment, to find product defects on real repositories. They ran at an earlier product commit and every defect they exposed was fixed in #323 before the development run, so none of these trials describes the product that was measured.

Defects found and fixed in #323:

- **Installed dependencies patched (winston, Drift).** A repair session edited `node_modules/logform/index.d.ts`. Git ignores it, the controller's compile passed, and the hidden validator's fresh install failed. Protected globs (`node_modules/**`) matched one directory level only, which let that file into the repair's scope. Now: dependency writes are detected, a session without a manifest change is rejected, the tree is reinstalled clean; globs use the shared matcher.
- **Repository commit hooks (ESLint, both conditions).** husky refused the harness's commit (generic trial excluded as `runner_error`) and the controller's commit of a 5.9M-token repair session, which was then reset. Remediation commits now skip hooks.
- **Baseline could not install (ESLint).** `npm install` failed with ERESOLVE at the pre-upgrade commit, so pre-existing failures reached an agent. npm peer conflicts are retried with `--legacy-peer-deps`.
- **Junk repair scope (ESLint).** `Node.js` and stack-frame fragments became allowed files. Output-derived paths must exist.
- **Agents ran broad verification despite the prompt** (every trial: 5–10 whole-project `tsc`/lint runs per session). Controller-verified sessions now run with a PreToolUse guard that refuses broad checks.
