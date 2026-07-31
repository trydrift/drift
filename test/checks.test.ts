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
    assert.deepEqual(labels('gradle', null), ['gradle test', 'gradle build -x test']);
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
