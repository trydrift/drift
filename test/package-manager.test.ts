import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeCommand,
  detectPackageManagers,
  packageManagerAmbiguities,
  packageManagerById,
  upgradeMany,
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
  const cargoUpgrade = (cargo: { section: 'dependencies' | 'dev-dependencies' | 'build-dependencies'; target?: string }) =>
    packageManagerById('cargo')!.upgrade({
      name: 'left-pad',
      version: '2.0.0',
      kind: cargo.section === 'dependencies' ? 'runtime' : 'dev',
      cargo,
    })!;

  test('pins the chosen version, per manager', () => {
    assert.equal(describeCommand(upgrade('npm')!), 'npm install left-pad@2.0.0');
    assert.equal(describeCommand(upgrade('pnpm')!), 'pnpm add left-pad@2.0.0');
    assert.equal(describeCommand(upgrade('yarn')!), 'yarn upgrade left-pad@2.0.0');
    // `add`, not `up`: berry's `up` moves every workspace that depends on the
    // package at once and does not touch peerDependencies, which is the wrong
    // tool for testing one candidate against one workspace.
    assert.equal(describeCommand(upgrade('yarn-berry')!), 'yarn add left-pad@2.0.0');
    assert.equal(describeCommand(upgrade('bun')!), 'bun add left-pad@2.0.0');
    assert.equal(describeCommand(upgrade('poetry')!), 'poetry add left-pad==2.0.0');
    assert.equal(describeCommand(upgrade('uv')!), 'uv add left-pad==2.0.0');
    assert.equal(describeCommand(upgrade('pip')!), 'pip install --upgrade left-pad==2.0.0');
    assert.equal(describeCommand(upgrade('cargo')!), 'cargo add left-pad@=2.0.0');
    assert.equal(describeCommand(upgrade('bundler')!), 'bundle update left-pad --conservative');
  });

  test('keeps the dependency section the package came from, for every npm-ecosystem manager and kind', () => {
    for (const id of ['npm', 'pnpm', 'yarn-berry', 'bun']) {
      assert.equal(describeCommand(upgrade(id, 'runtime')!), `${describeCommand(upgrade(id)!)}`, `${id}: runtime adds no flag`);
    }

    assert.equal(describeCommand(upgrade('npm', 'dev')!), 'npm install left-pad@2.0.0 --save-dev');
    assert.equal(describeCommand(upgrade('npm', 'optional')!), 'npm install left-pad@2.0.0 --save-optional');
    assert.equal(describeCommand(upgrade('npm', 'peer')!), 'npm install left-pad@2.0.0 --save-peer');

    assert.equal(describeCommand(upgrade('pnpm', 'dev')!), 'pnpm add left-pad@2.0.0 --save-dev');
    assert.equal(describeCommand(upgrade('pnpm', 'optional')!), 'pnpm add left-pad@2.0.0 --save-optional');
    assert.equal(describeCommand(upgrade('pnpm', 'peer')!), 'pnpm add left-pad@2.0.0 --save-peer');

    assert.equal(describeCommand(upgrade('yarn-berry', 'dev')!), 'yarn add left-pad@2.0.0 --dev');
    assert.equal(describeCommand(upgrade('yarn-berry', 'optional')!), 'yarn add left-pad@2.0.0 --optional');
    assert.equal(describeCommand(upgrade('yarn-berry', 'peer')!), 'yarn add left-pad@2.0.0 --peer');

    assert.equal(describeCommand(upgrade('bun', 'dev')!), 'bun add left-pad@2.0.0 --dev');
    assert.equal(describeCommand(upgrade('bun', 'optional')!), 'bun add left-pad@2.0.0 --optional');
    assert.equal(describeCommand(upgrade('bun', 'peer')!), 'bun add left-pad@2.0.0 --peer');

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

  test('cargo keeps the dependency table and target it came from', () => {
    assert.deepEqual(cargoUpgrade({ section: 'dependencies' }).args, ['add', 'left-pad@=2.0.0']);
    assert.deepEqual(cargoUpgrade({ section: 'dev-dependencies' }).args, [
      'add',
      'left-pad@=2.0.0',
      '--dev',
    ]);
    assert.deepEqual(cargoUpgrade({ section: 'build-dependencies' }).args, [
      'add',
      'left-pad@=2.0.0',
      '--build',
    ]);
    assert.deepEqual(
      cargoUpgrade({ section: 'dependencies', target: 'cfg(not(target_arch = "wasm32"))' }).args,
      ['add', 'left-pad@=2.0.0', '--target', 'cfg(not(target_arch = "wasm32"))'],
    );
    assert.deepEqual(cargoUpgrade({ section: 'dev-dependencies', target: 'cfg(unix)' }).args, [
      'add',
      'left-pad@=2.0.0',
      '--dev',
      '--target',
      'cfg(unix)',
    ]);
    assert.deepEqual(cargoUpgrade({ section: 'build-dependencies', target: 'cfg(windows)' }).args, [
      'add',
      'left-pad@=2.0.0',
      '--build',
      '--target',
      'cfg(windows)',
    ]);
  });
});

describe('manifest rewriting', () => {
  const target = { name: 'left-pad', version: '2.0.0', kind: 'runtime' as const };
  const rewrite = (id: string, content: string, manifestPath = 'requirements.txt') =>
    packageManagerById(id as never)!.rewriteManifest!(content, target, manifestPath);

  test('pins requirements.txt to an exact version, whatever specifier was there', () => {
    assert.equal(rewrite('pip', 'left-pad==1.0.0\n'), 'left-pad==2.0.0\n');
    assert.equal(rewrite('pip', 'left-pad>=1.0,<2.0\n'), 'left-pad==2.0.0\n');
    assert.equal(rewrite('pip', 'left-pad\n'), 'left-pad==2.0.0\n');
    assert.equal(rewrite('pip', 'left_pad==1.0.0\n'), 'left_pad==2.0.0\n');
    assert.equal(rewrite('pip', 'left-pad[extra]==1.0.0\n'), 'left-pad[extra]==2.0.0\n');
    assert.equal(rewrite('pip', 'other-pkg==1.0.0\n'), 'other-pkg==1.0.0\n');
  });

  test('pins a pyproject.toml PEP 621 dependency entry to an exact version', () => {
    assert.equal(
      rewrite('pip', 'dependencies = [\n  "left-pad>=1.0,<2.0",\n]\n', 'pyproject.toml'),
      'dependencies = [\n  "left-pad==2.0.0",\n]\n',
    );
    assert.equal(
      rewrite('pip', "dependencies = [\n  'left-pad',\n]\n", 'pyproject.toml'),
      "dependencies = [\n  'left-pad==2.0.0',\n]\n",
    );
  });

  test('pins a setup.py install_requires entry to an exact version', () => {
    assert.equal(
      rewrite('pip', "install_requires=[\n    'left-pad==1.0.0',\n]\n", 'setup.py'),
      "install_requires=[\n    'left-pad==2.0.0',\n]\n",
    );
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

describe('moving several packages at once', () => {
  const many = (id: string, targets: Array<[string, string, string?]>) =>
    upgradeMany(
      packageManagerById(id as never)!,
      targets.map(([name, version, kind]) => ({ name, version, kind: (kind ?? 'runtime') as never })),
    )?.map((command) => [command.command, ...command.args].join(' '));
  const cargoMany = (
    targets: Array<{
      name: string;
      version: string;
      cargo?: { section: 'dependencies' | 'dev-dependencies' | 'build-dependencies'; target?: string };
    }>,
  ) =>
    upgradeMany(
      packageManagerById('cargo')!,
      targets.map(({ name, version, cargo }) => ({
        name,
        version,
        kind: cargo?.section === 'dev-dependencies' || cargo?.section === 'build-dependencies' ? 'dev' : 'runtime',
        ...(cargo ? { cargo } : {}),
      })),
    )?.map((command) => [command.command, ...command.args]);

  test('merges into one invocation', () => {
    assert.deepEqual(many('npm', [['react', '19.2.0'], ['vite', '7.1.0']]), [
      'npm install react@19.2.0 vite@7.1.0',
    ]);
    assert.deepEqual(many('cargo', [['serde', '1.0.2'], ['tokio', '1.40.0']]), [
      'cargo add serde@=1.0.2 tokio@=1.40.0',
    ]);
    assert.deepEqual(many('go', [['github.com/a/b', '1.2.0'], ['github.com/c/d', 'v2.0.0']]), [
      'go get github.com/a/b@v1.2.0 github.com/c/d@v2.0.0',
    ]);
    assert.deepEqual(many('bundler', [['rails', '7.1.0'], ['puma', '6.4.0']]), [
      'bundle update rails puma --conservative',
    ]);
  });

  test('a flag that differs splits the batch rather than being dropped', () => {
    // Merging these would move `vitest` out of devDependencies, which is a
    // different guarantee to this package's consumers, not a version bump.
    assert.deepEqual(
      many('npm', [
        ['react', '19.2.0'],
        ['vitest', '3.0.0', 'dev'],
        ['vite', '7.1.0'],
      ]),
      ['npm install react@19.2.0 vite@7.1.0', 'npm install vitest@3.0.0 --save-dev'],
    );
  });

  test('cargo batches only dependencies with compatible placement flags', () => {
    assert.deepEqual(
      cargoMany([
        { name: 'serde', version: '1.0.2' },
        { name: 'tokio', version: '1.40.0' },
      ]),
      [['cargo', 'add', 'serde@=1.0.2', 'tokio@=1.40.0']],
    );

    assert.deepEqual(
      cargoMany([
        { name: 'sha2', version: '0.11.0', cargo: { section: 'dependencies', target: 'cfg(unix)' } },
        { name: 'digest', version: '0.11.0', cargo: { section: 'dependencies', target: 'cfg(unix)' } },
      ]),
      [['cargo', 'add', 'sha2@=0.11.0', 'digest@=0.11.0', '--target', 'cfg(unix)']],
    );

    assert.deepEqual(
      cargoMany([
        { name: 'sha2', version: '0.11.0', cargo: { section: 'dependencies', target: 'cfg(unix)' } },
        { name: 'digest', version: '0.11.0', cargo: { section: 'dependencies', target: 'cfg(windows)' } },
      ]),
      [
        ['cargo', 'add', 'sha2@=0.11.0', '--target', 'cfg(unix)'],
        ['cargo', 'add', 'digest@=0.11.0', '--target', 'cfg(windows)'],
      ],
    );

    assert.deepEqual(
      cargoMany([
        { name: 'serde', version: '1.0.2' },
        { name: 'sha2', version: '0.11.0', cargo: { section: 'dependencies', target: 'cfg(unix)' } },
      ]),
      [
        ['cargo', 'add', 'serde@=1.0.2'],
        ['cargo', 'add', 'sha2@=0.11.0', '--target', 'cfg(unix)'],
      ],
    );

    assert.deepEqual(
      cargoMany([
        { name: 'criterion', version: '0.6.0', cargo: { section: 'dev-dependencies' } },
        { name: 'cc', version: '1.2.0', cargo: { section: 'build-dependencies' } },
      ]),
      [
        ['cargo', 'add', 'criterion@=0.6.0', '--dev'],
        ['cargo', 'add', 'cc@=1.2.0', '--build'],
      ],
    );
  });

  test('a command that names no package collapses to one run', () => {
    // Conan and vcpkg declare the version in the manifest; the rewrite is the
    // upgrade, and the command only re-resolves against it.
    assert.deepEqual(many('conan', [['zlib', '1.3.1'], ['fmt', '11.0.0']]), [
      'conan install . --build=missing',
    ]);
  });

  test('a manager that takes one package per command declines', () => {
    assert.equal(many('dotnet', [['Serilog', '4.0.0'], ['Polly', '8.0.0']]), undefined);
    assert.equal(many('rebar', [['cowboy', '2.12.0'], ['jsx', '3.1.0']]), undefined);
  });

  test('a manager with no upgrade command at all declines', () => {
    assert.equal(many('gradle', [['com.google.guava:guava', '33.0.0']]), undefined);
  });

  test('one target is still one command', () => {
    assert.deepEqual(many('pnpm', [['zod', '4.4.3']]), ['pnpm add zod@4.4.3']);
  });
});

describe('finding the package specifier in a command', () => {
  test('a package named after the subcommand does not confuse the merge', () => {
    // `npm install install@2.0.0`: searching for the argument *containing* the
    // package name finds the verb first, and merging there produces
    // `npm install@2.0.0 install` — a command that installs nothing.
    const merged = upgradeMany(packageManagerById('npm')!, [
      { name: 'install', version: '2.0.0', kind: 'runtime' },
      { name: 'react', version: '19.2.0', kind: 'runtime' },
    ])?.map((command) => [command.command, ...command.args].join(' '));

    assert.deepEqual(merged, ['npm install install@2.0.0 react@19.2.0']);
  });

  test('a package named after a flag stays in the specifier position', () => {
    const merged = upgradeMany(packageManagerById('pnpm')!, [
      { name: 'add', version: '1.0.0', kind: 'runtime' },
    ])?.map((command) => [command.command, ...command.args].join(' '));

    assert.deepEqual(merged, ['pnpm add add@1.0.0']);
  });
});
