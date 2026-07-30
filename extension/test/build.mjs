import { build } from 'esbuild';

/**
 * CommonJS on purpose: the bundle pulls in the TypeScript compiler (used by the
 * .d.ts surface diff and the Meta-RAG index), which references `__filename` and
 * therefore cannot run in an ES module scope.
 *
 * `vscode` is aliased to a stub so extension code runs under plain Node.
 */
await build({
  entryPoints: ['test/harness.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'dist/harness.cjs',
  alias: { vscode: './test/vscode-stub.ts' },
  logLevel: 'warning',
});

/**
 * The panel render tests, bundled for the same reason: extension sources use
 * `.js` specifiers that only a bundler resolves. Rendering the real panel in
 * plain Node is the only automated check that the largest file in the extension
 * produces the markup it claims to.
 */
await build({
  entryPoints: ['test/panel.test.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'dist/panel.test.cjs',
  alias: { vscode: './test/vscode-stub.ts' },
  logLevel: 'warning',
});
