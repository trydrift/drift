import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { diffSurfaces, inferReplacement } from '../dist/evidence/type-surface.js';

/**
 * A removal with no successor leaves Drift's deterministic tiers idle (a
 * codemod needs a target) and leaves agents reading the package's own source.
 * Both published surfaces are already in hand when the removal is found, so
 * where they name the successor unambiguously, Drift says so — and where they
 * do not, it stays silent rather than guessing.
 */

const entry = (name: string, kind: string, signature: string, members: string[] = []) =>
  ({ name, kind, signature, members, requiredMembers: [] }) as never;

describe('inferring what replaced a removed export', () => {
  test('the package name merged into the old one: glob.sync -> globSync', () => {
    const removed = entry('default.sync', 'function', 'function default.sync(pattern: string, options?: IOptions): string[];');
    const added = [entry('globSync', 'function', 'export declare function globSync(pattern: string | string[], options: GlobOptions): string[];'), entry('Glob', 'class', 'class Glob')];
    assert.equal(inferReplacement(removed, added, 'glob')?.name, 'globSync');
  });

  test('the same declaration under a new name', () => {
    const removed = entry('Logger', 'function', 'function Logger(options: LoggerOptions): Instance;');
    const added = [entry('createLogger', 'function', 'function createLogger(options: LoggerOptions): Instance;')];
    assert.equal(inferReplacement(removed, added, 'winston')?.name, 'createLogger');
  });

  // A name that merely *contains* the old one is not evidence of anything. On
  // vue 2 -> 3 this read `Vue` as replaced by `CompatVue` — an internal
  // compatibility symbol — and the codemod tier then rewrote `new Vue({...})`
  // to `new CompatVue({...})` when the migration is `createApp(App).mount()`.
  test('a new name that merely ends with the old one is not a successor', () => {
    const removed = entry('Vue', 'variable', 'const Vue: VueConstructor');
    const added = [entry('CompatVue', 'variable', 'const CompatVue: CompatVue')];
    assert.equal(inferReplacement(removed, added, 'vue'), null);
  });

  test('a successor in another package is not a name a consumer can write', () => {
    const removed = entry('IfAny', 'type', 'type IfAny<T, Y, N> = 0 extends 1 & T ? Y : N;');
    const added = [entry('@vue/shared#IfAny', 'type', 'type IfAny<T, Y, N> = 0 extends 1 & T ? Y : N;')];
    assert.equal(inferReplacement(removed, added, 'vue'), null);
  });

  test('a bare declaration header identifies nothing: nineteen interfaces do not all become the one that was added', () => {
    const removed = entry('AbstractConfigSet', 'interface', 'interface default.AbstractConfigSet');
    const added = [entry('LogEntry', 'interface', 'interface default.LogEntry')];
    assert.equal(inferReplacement(removed, added, 'winston'), null);
  });

  test('ambiguity and short names yield nothing', () => {
    const removed = entry('Client', 'class', 'class Client', ['a', 'b']);
    assert.equal(inferReplacement(removed, [entry('ApiClient', 'class', 'class ApiClient', ['a', 'b']), entry('HttpClient', 'class', 'class HttpClient', ['a', 'b'])], 'sdk'), null);
    assert.equal(inferReplacement(entry('go', 'function', 'function go(): void'), [entry('pkgGo', 'function', 'function pkgGo(): void')], 'pkg'), null);
  });

  test('diffSurfaces reports the successor on the removal, and says so in the detail', () => {
    const before = new Map([['sync', entry('sync', 'function', 'function sync(pattern: string, options?: IOptions): string[];')]]);
    const after = new Map([['globSync', entry('globSync', 'function', 'function globSync(pattern: string, options?: GlobOptions): string[];')]]);
    const [change] = diffSurfaces(before as never, after as never, { packageName: 'glob' });
    assert.equal(change!.kind, 'export-removed');
    assert.equal(change!.replacement, 'globSync');
    assert.match(change!.detail, /The new version exports `globSync` in its place/);
  });

  test('with nothing added, a removal stays a plain removal', () => {
    const before = new Map([['gone', entry('gone', 'function', 'function gone(a: string, b: number): void;')]]);
    const [change] = diffSurfaces(before as never, new Map() as never, { packageName: 'pkg' });
    assert.equal(change!.replacement, undefined);
    assert.doesNotMatch(change!.detail, /in its place/);
  });
});
