import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectChecks } from '../dist/detect/checks.js';

/**
 * The offer to verify a fix is only useful if it names checks that exist.
 * `npm run typecheck` in a project with no such script fails for a reason that
 * has nothing to do with the fix, and a meaningless red mark is worse than no
 * check at all.
 */

const labels = (manager: string, manifest: string | null) =>
  detectChecks(manager as never, manifest).map((c) => c.label);

const capabilities = (manager: string, manifest: string | null) =>
  detectChecks(manager as never, manifest).map((c) => [c.kind, c.compileCapable] as const);

const origins = (manager: string, manifest: string | null) =>
  detectChecks(manager as never, manifest).map((c) => c.commandOrigin);

describe('node projects declare their own checks', () => {
  const manifest = JSON.stringify({
    scripts: { typecheck: 'tsc --noEmit', test: 'node --test', build: 'tsc', lint: 'eslint .' },
  });

  test('reads the scripts that exist, in the order that explains failures', () => {
    assert.deepEqual(labels('npm', manifest), ['npm run typecheck', 'npm test', 'npm run build']);
  });

  test('offers nothing it cannot find', () => {
    assert.deepEqual(labels('npm', '{"scripts":{"lint":"eslint ."}}'), []);
    assert.deepEqual(labels('npm', '{}'), []);
    assert.deepEqual(labels('npm', 'not json'), []);
  });

  test('accepts the conventional spellings of a typecheck script', () => {
    assert.deepEqual(labels('npm', '{"scripts":{"type-check":"tsc"}}'), ['npm run type-check']);
    assert.deepEqual(labels('npm', '{"scripts":{"check-types":"tsc"}}'), ['npm run check-types']);
  });

  test('uses each runner the way a developer would type it', () => {
    assert.deepEqual(labels('pnpm', manifest), ['pnpm run typecheck', 'pnpm test', 'pnpm run build']);
    assert.deepEqual(labels('yarn', manifest), ['yarn typecheck', 'yarn test', 'yarn build']);
    assert.deepEqual(labels('bun', manifest), ['bun run typecheck', 'bun test', 'bun run build']);
  });
});

describe('a check can only clear compiler-provable findings if it actually compiles', () => {
  test('a "typecheck"- or "check"-named script that runs tsc is compile-capable', () => {
    const manifest = JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } });
    assert.deepEqual(capabilities('npm', manifest), [['typecheck', true]]);
  });

  test('a "check"-named script that is actually a linter is not compile-capable', () => {
    // The bug this exists for: `SCRIPT_NAMES.typecheck` includes `check`, so
    // `"check": "eslint ."` used to be trusted to clear a signature change it
    // never looked at.
    const manifest = JSON.stringify({ scripts: { check: 'eslint .' } });
    assert.deepEqual(capabilities('npm', manifest), [['typecheck', false]]);
  });

  test('a "build"-named script that just bundles is not compile-capable', () => {
    const manifest = JSON.stringify({ scripts: { build: 'vite build' } });
    assert.deepEqual(capabilities('npm', manifest), [['build', false]]);
  });

  test('a "build"-named script that runs tsc is compile-capable', () => {
    const manifest = JSON.stringify({ scripts: { build: 'tsc -p tsconfig.json' } });
    assert.deepEqual(capabilities('npm', manifest), [['build', true]]);
  });

  test('recognizes vue-tsc and svelte-check, run directly or through npx', () => {
    assert.deepEqual(capabilities('npm', JSON.stringify({ scripts: { typecheck: 'vue-tsc --noEmit' } })), [
      ['typecheck', true],
    ]);
    assert.deepEqual(capabilities('npm', JSON.stringify({ scripts: { typecheck: 'svelte-check' } })), [
      ['typecheck', true],
    ]);
    assert.deepEqual(capabilities('npm', JSON.stringify({ scripts: { typecheck: 'npx tsc --noEmit' } })), [
      ['typecheck', true],
    ]);
  });

  test('a compiler chained after another command still counts', () => {
    const manifest = JSON.stringify({ scripts: { build: 'rimraf dist && tsc -p tsconfig.build.json' } });
    assert.deepEqual(capabilities('npm', manifest), [['build', true]]);
  });

  test('a test script is never treated as compile-capable, even when it happens to run tsc', () => {
    const manifest = JSON.stringify({ scripts: { test: 'tsc --noEmit && jest' } });
    assert.deepEqual(capabilities('npm', manifest), [['test', false]]);
  });

  test('every hardcoded, non-Node toolchain check states its capability explicitly', () => {
    assert.deepEqual(capabilities('cargo', null), [
      ['typecheck', true],
      ['test', false],
      ['build', true],
    ]);
    assert.deepEqual(capabilities('go', null), [
      ['typecheck', true],
      ['test', false],
      ['build', true],
    ]);
  });

  test('C/C++ has no separate typecheck, so its build step is the compile-capable one', () => {
    assert.deepEqual(capabilities('conan', null), [['build', true]]);
    assert.deepEqual(capabilities('vcpkg', null), [['build', true]]);
  });
});

describe('toolchains that supply their own checks', () => {
  test('cargo and go need no manifest to know what to run', () => {
    assert.deepEqual(labels('cargo', null), ['cargo check', 'cargo test', 'cargo build']);
    assert.deepEqual(labels('go', null), ['go vet ./...', 'go test ./...', 'go build ./...']);
  });

  test('maven and gradle offer what those tools actually have', () => {
    assert.deepEqual(labels('maven', null), [
      'mvn -q test-compile',
      'mvn -q test',
      'mvn -q package -DskipTests',
    ]);
    assert.deepEqual(labels('gradle', null), [
      'gradle compileTestJava',
      'gradle test',
      'gradle build -x test',
    ]);
  });
});

describe('python and ruby, where the tool is declared rather than assumed', () => {
  const pyproject = `[project]
dependencies = ["httpx"]

[tool.mypy]
strict = true

[tool.pytest.ini_options]
testpaths = ["tests"]
`;

  test('runs declared tools through the project runner', () => {
    assert.deepEqual(labels('poetry', pyproject), ['poetry run mypy .', 'poetry run pytest']);
    assert.deepEqual(labels('uv', pyproject), ['uv run mypy .', 'uv run pytest']);
    assert.deepEqual(labels('pip', pyproject), ['mypy .', 'pytest']);
  });

  test('a tool named only in the dependency list still counts', () => {
    assert.deepEqual(labels('uv', '[project]\ndependencies = ["pytest", "pyright"]\n'), [
      'uv run pyright',
      'uv run pytest',
    ]);
  });

  test('a project declaring no checker is offered none', () => {
    assert.deepEqual(labels('poetry', '[project]\nname = "x"\n'), []);
  });

  test('the Gemfile decides between rspec and rake', () => {
    assert.deepEqual(labels('bundler', 'gem "rspec", "~> 3.0"\n'), ['bundle exec rspec']);
    assert.deepEqual(labels('bundler', 'gem "minitest"\n'), ['bundle exec rake test']);
    assert.deepEqual(labels('bundler', 'gem "rails"\n'), []);
  });
});

describe('composer-installed check binaries', () => {
  test('raw vendor/bin checks are marked as post-install commands', () => {
    const manifest = JSON.stringify({
      'require-dev': { 'phpunit/phpunit': '^10', 'phpstan/phpstan': '^1' },
    });

    assert.deepEqual(labels('composer', manifest), ['vendor/bin/phpstan analyse', 'vendor/bin/phpunit']);
    assert.deepEqual(origins('composer', manifest), [
      { kind: 'post-install', requiredHostCommands: ['composer'] },
      { kind: 'post-install', requiredHostCommands: ['composer'] },
    ]);
  });

  test('composer scripts are host commands because composer runs them', () => {
    assert.deepEqual(origins('composer', JSON.stringify({ scripts: { test: 'phpunit' } })), [
      { kind: 'host', command: 'composer' },
    ]);
  });
});
