import { existsSync, readdirSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

/**
 * CommonJS on purpose: the bundle pulls in the TypeScript compiler (used by the
 * .d.ts surface diff and the Meta-RAG index), which references `__filename` and
 * therefore cannot run in an ES module scope.
 *
 * `vscode` is aliased to a stub so extension code runs under plain Node.
 */
if (existsSync('dist')) {
  for (const name of readdirSync('dist', { withFileTypes: true })) {
    if (name.isFile() && name.name.endsWith('.test.cjs')) rmSync(`dist/${name.name}`);
  }
}

await build({
  entryPoints: ['test/harness.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'dist/harness.cjs',
  alias: { vscode: './test/vscode-stub.ts' },
  logLevel: 'warning',
  // See extension/esbuild.mjs: behavioural.ts's import.meta.url branch is
  // dead code in CJS bundles, so this warning is a false positive.
  logOverride: { 'empty-import-meta': 'silent' },
});

/**
 * Every test file, bundled for the same reason: extension sources use `.js`
 * specifiers that only a bundler resolves. Rendering the real panel in plain
 * Node is the only automated check that the largest file in the extension
 * produces the markup it claims to.
 */
for (const name of readdirSync('test').filter((f) => f.endsWith('.test.ts'))) {
  await build({
    entryPoints: [`test/${name}`],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: `dist/${name.replace(/\.ts$/, '.cjs')}`,
    alias: { vscode: './test/vscode-stub.ts' },
    logLevel: 'warning',
    logOverride: { 'empty-import-meta': 'silent' },
  });
}
