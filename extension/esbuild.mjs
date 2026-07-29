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

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('watching…');
} else {
  await build(options);
}
