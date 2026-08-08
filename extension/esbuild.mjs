import { build, context } from 'esbuild';

/**
 * The extension ships as one bundled CommonJS file.
 *
 * `vscode` is external because the editor provides it at runtime — bundling it
 * is impossible and attempting to is the classic first mistake.
 */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  minify: !process.argv.includes('--watch'),
  sourcemap: process.argv.includes('--watch'),
  logLevel: 'info',
};

/**
 * `verification/behavioural.ts` (pulled into this bundle via
 * `../../src/analysis.ts`) spawns `behavioural-worker.js` as a separate `node`
 * process rather than importing it, so esbuild never inlines it into
 * `dist/extension.js` the way it does everything actually `import`ed. It has
 * to be built and placed next to the bundle by hand: the module resolves it
 * relative to `__dirname` in this CJS bundle, so it must land in `dist/`
 * alongside `extension.js` as CommonJS too (this package has no
 * `"type": "module"`, so plain `.js` here means CJS) — not wherever the main
 * package's own ESM `tsc` build put its copy.
 */
const workerOptions = {
  entryPoints: ['../src/verification/behavioural-worker.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'dist/behavioural-worker.js',
  minify: !process.argv.includes('--watch'),
  sourcemap: process.argv.includes('--watch'),
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  const [ctx, workerCtx] = await Promise.all([context(options), context(workerOptions)]);
  await Promise.all([ctx.watch(), workerCtx.watch()]);
  console.log('watching…');
} else {
  await Promise.all([build(options), build(workerOptions)]);
}
