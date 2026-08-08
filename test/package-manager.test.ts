import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeCommand,
  detectPackageManagers,
  packageManagerAmbiguities,
  packageManagerById,
} from '../dist/detect/package-manager.js';

const ids = (entries: readonly string[], read?: (name: string) => string | null) =>
  detectPackageManagers({ entries, read }).map((d) => d.manager.id);

describe('package manager detection', () => {
  test('picks the manager whose lockfile is present', () => {
    assert.deepEqual(ids(['package.json', 'package-lock.json']), ['npm']);
    assert.deepEqual(ids(['package.json', 'pnpm-lock.yaml']), ['pnpm']);
    assert.deepEqual(ids(['package.json', 'bun.lockb']), ['bun']);
  });

  test('falls back to the manifest when no lockfile is committed', () => {
    assert.deepEqual(ids(['package.json']), ['npm', 'pnpm', 'yarn', 'bun']);
  });

  test('a lockfile suppresses manifest-only siblings in the same ecosystem', () => {
    const detected = detectPackageManagers({ entries: ['package.json', 'pnpm-lock.yaml'] });
    assert.equal(detected.length, 1);
    assert.equal(detected[0]!.fromLockfile, true);
    assert.deepEqual(detected[0]!.evidence, ['pnpm-lock.yaml', 'package.json']);
  });

  test('tells yarn classic from berry', () => {
    assert.deepEqual(ids(['package.json', 'yarn.lock']), ['yarn']);
    assert.deepEqual(ids(['package.json', 'yarn.lock', '.yarnrc.yml']), ['yarn-berry']);
    assert.deepEqual(
      ids(['package.json', 'yarn.lock'], (name) =>
        name === 'yarn.lock' ? '__metadata:\n  version: 8\n' : null,
      ),
      ['yarn-berry'],
    );
  });

  test('covers the non-npm ecosystems', () => {
    assert.deepEqual(ids(['pyproject.toml', 'poetry.lock']), ['poetry']);
    assert.deepEqual(ids(['pyproject.toml', 'uv.lock']), ['uv']);
    assert.deepEqual(ids(['requirements.txt']), ['pip']);
    assert.deepEqual(ids(['go.mod', 'go.sum']), ['go']);
    assert.deepEqual(ids(['Cargo.toml', 'Cargo.lock']), ['cargo']);
    assert.deepEqual(ids(['Gemfile', 'Gemfile.lock']), ['bundler']);
    assert.deepEqual(ids(['pom.xml']), ['maven']);
    assert.deepEqual(ids(['build.gradle.kts', 'gradle.lockfile']), ['gradle']);
  });

  test('reports nothing for a directory with no manifests', () => {
    assert.deepEqual(ids(['README.md', 'src']), []);
  });

  test('detects several ecosystems side by side without calling it ambiguous', () => {
    const detected = detectPackageManagers({
      entries: ['package.json', 'package-lock.json', 'Cargo.toml', 'Cargo.lock'],
    });
    assert.deepEqual(detected.map((d) => d.manager.id), ['npm', 'cargo']);
    assert.deepEqual(packageManagerAmbiguities(detected), []);
  });
});

describe('package manager ambiguity', () => {
  test('flags two lockfiles for one ecosystem', () => {
    const detected = detectPackageManagers({
      entries: ['package.json', 'package-lock.json', 'pnpm-lock.yaml'],
    });
    const ambiguities = packageManagerAmbiguities(detected);
    assert.equal(ambiguities.length, 1);
    assert.equal(ambiguities[0]!.ecosystem, 'npm');
    assert.deepEqual(ambiguities[0]!.candidates.map((c) => c.manager.id), ['npm', 'pnpm']);
  });

  test('a bare manifest is ambiguous too, since any of them could own it', () => {
    const ambiguities = packageManagerAmbiguities(detectPackageManagers({ entries: ['package.json'] }));
    assert.equal(ambiguities.length, 1);
    assert.equal(ambiguities[0]!.candidates.length, 4);
  });
});

describe('upgrade commands', () => {
  const upgrade = (id: string, kind = 'runtime') =>
    packageManagerById(id as never)!.upgrade({ name: 'left-pad', version: '2.0.0', kind: kind as never });

  test('pins the chosen version, per manager', () => {
    assert.equal(describeCommand(upgrade('npm')!), 'npm install left-pad@2.0.0');
    assert.equal(describeCommand(upgrade('pnpm')!), 'pnpm add left-pad@2.0.0');
    assert.equal(describeCommand(upgrade('yarn')!), 'yarn upgrade left-pad@2.0.0');
    assert.equal(describeCommand(upgrade('yarn-berry')!), 'yarn up left-pad@2.0.0');
    assert.equal(describeCommand(upgrade('bun')!), 'bun add left-pad@2.0.0');
    assert.equal(describeCommand(upgrade('poetry')!), 'poetry add left-pad==2.0.0');
    assert.equal(describeCommand(upgrade('uv')!), 'uv add left-pad==2.0.0');
    assert.equal(describeCommand(upgrade('pip')!), 'pip install --upgrade left-pad==2.0.0');
    assert.equal(describeCommand(upgrade('cargo')!), 'cargo add left-pad@2.0.0');
    assert.equal(describeCommand(upgrade('bundler')!), 'bundle update left-pad --conservative');
  });

  test('keeps the dependency section the package came from', () => {
    assert.equal(describeCommand(upgrade('npm', 'dev')!), 'npm install left-pad@2.0.0 --save-dev');
    assert.equal(describeCommand(upgrade('npm', 'optional')!), 'npm install left-pad@2.0.0 --save-optional');
    assert.equal(describeCommand(upgrade('bun', 'dev')!), 'bun add left-pad@2.0.0 --dev');
    assert.equal(describeCommand(upgrade('poetry', 'dev')!), 'poetry add left-pad==2.0.0 --group dev');
    assert.equal(describeCommand(upgrade('uv', 'dev')!), 'uv add left-pad==2.0.0 --dev');
  });

  test('go modules take a v-prefixed version, exactly once', () => {
    const go = packageManagerById('go')!;
    assert.equal(
      describeCommand(go.upgrade({ name: 'github.com/a/b', version: '1.2.3', kind: 'runtime' })!),
      'go get github.com/a/b@v1.2.3',
    );
    assert.equal(
      describeCommand(go.upgrade({ name: 'github.com/a/b', version: 'v1.2.3', kind: 'runtime' })!),
      'go get github.com/a/b@v1.2.3',
    );
  });

  test('gradle admits it cannot pin a version from the command line', () => {
    assert.equal(upgrade('gradle'), null);
  });
});

describe('manifest rewriting', () => {
  const target = { name: 'left-pad', version: '2.0.0', kind: 'runtime' as const };
  const rewrite = (id: string, content: string) =>
    packageManagerById(id as never)!.rewriteManifest!(content, target);

  test('pins requirements.txt to an exact version, whatever specifier was there', () => {
    assert.equal(rewrite('pip', 'left-pad==1.0.0\n'), 'left-pad==2.0.0\n');
    assert.equal(rewrite('pip', 'left-pad>=1.0,<2.0\n'), 'left-pad==2.0.0\n');
    assert.equal(rewrite('pip', 'left-pad\n'), 'left-pad==2.0.0\n');
    assert.equal(rewrite('pip', 'left_pad==1.0.0\n'), 'left_pad==2.0.0\n');
    assert.equal(rewrite('pip', 'left-pad[extra]==1.0.0\n'), 'left-pad[extra]==2.0.0\n');
    assert.equal(rewrite('pip', 'other-pkg==1.0.0\n'), 'other-pkg==1.0.0\n');
  });

  test('rewrites a Gemfile constraint, or adds one to a bare gem', () => {
    assert.equal(rewrite('bundler', "gem 'left-pad', '~> 1.0'\n"), "gem 'left-pad', '2.0.0'\n");
    assert.equal(rewrite('bundler', "gem 'left-pad'\n"), "gem 'left-pad', '2.0.0'\n");
  });

  test('rewrites a mix.exs dependency tuple to an exact pin', () => {
    assert.equal(
      rewrite('mix', 'defp deps do\n  [{:left-pad, "~> 1.0"}]\nend\n'),
      'defp deps do\n  [{:left-pad, "== 2.0.0"}]\nend\n',
    );
  });

  test('rewrites a rebar.config dependency tuple to an exact pin', () => {
    assert.equal(
      rewrite('rebar', '{deps, [{left-pad, "1.0.0"}]}.\n'),
      '{deps, [{left-pad, "2.0.0"}]}.\n',
    );
  });

  test('rewrites a Podfile constraint, or adds one to a bare pod', () => {
    assert.equal(rewrite('cocoapods', "pod 'left-pad', '~> 1.0'\n"), "pod 'left-pad', '2.0.0'\n");
    assert.equal(rewrite('cocoapods', "pod 'left-pad'\n"), "pod 'left-pad', '2.0.0'\n");
  });
});
