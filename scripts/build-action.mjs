#!/usr/bin/env node
// Builds the self-contained Action bundle (`action/index.cjs`).
//
// Bundling alone is not enough: `verification/behavioural.ts` spawns
// `behavioural-worker.js` as a separate `node` process rather than importing
// it, so esbuild has no reason to inline it and it never ends up in
// `action/index.cjs`. It has to be copied next to the bundle by hand, same as
// the CJS bundle path-resolution fix in `behavioural.ts` (`__dirname`) assumes
// a sibling file exists at all. Without this copy, `verification.behavioural`
// is broken in the Action the instant a user turns it on.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function log(msg) {
  console.log(`[build-action] ${msg}`);
}

const workerSource = `${repoRoot}/dist/verification/behavioural-worker.js`;
if (!existsSync(workerSource)) {
  log('dist/verification/behavioural-worker.js missing; running `npm run build` first');
  execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' });
}

log('bundling src/runners/action-entry.ts -> action/index.cjs');
execFileSync(
  'npx',
  [
    'esbuild',
    'src/runners/action-entry.ts',
    '--bundle',
    '--platform=node',
    '--target=node24',
    '--format=cjs',
    '--minify',
    '--outfile=action/index.cjs',
  ],
  { cwd: repoRoot, stdio: 'inherit' },
);

log('copying behavioural-worker.js next to action/index.cjs');
copyFileSync(workerSource, `${repoRoot}/action/behavioural-worker.js`);

log('done');
