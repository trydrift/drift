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
  // `verification/behavioural.ts` guards its `import.meta.url` use behind a
  // `typeof __dirname` check that always takes the __dirname branch in this
  // CJS bundle — esbuild's "empty-import-meta" warning is a false positive.
  logOverride: { 'empty-import-meta': 'silent' },
  metafile: true,
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

const highlightOptions = {
  entryPoints: ['src/webview/highlight-client.ts'],
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  splitting: false,
  outfile: 'dist/highlight-client.js',
  minify: !process.argv.includes('--watch'),
  sourcemap: process.argv.includes('--watch'),
  logLevel: 'info',
  metafile: true,
};

function assertBundleBoundary(result) {
  if (Object.keys(result.metafile.inputs).some((input) => input.includes('node_modules/highlight.js/'))) {
    throw new Error('highlight.js must only be bundled into dist/highlight-client.js, not the VS Code Extension Host.');
  }
}

function assertHighlightClient(result) {
  if (!Object.keys(result.metafile.inputs).some((input) => input.includes('node_modules/highlight.js/'))) {
    throw new Error('dist/highlight-client.js must bundle highlight.js.');
  }
}

if (process.argv.includes('--watch')) {
  const [ctx, workerCtx, highlightCtx] = await Promise.all([context(options), context(workerOptions), context(highlightOptions)]);
  await Promise.all([ctx.watch(), workerCtx.watch(), highlightCtx.watch()]);
  console.log('watching…');
} else {
  const [extension, , highlight] = await Promise.all([build(options), build(workerOptions), build(highlightOptions)]);
  assertBundleBoundary(extension);
  assertHighlightClient(highlight);
}
