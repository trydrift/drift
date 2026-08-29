import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectChanges, triage } from '../dist/detect/index.js';
import { classifyBump, isZeroVerBreaking, normalizeVersion } from '../dist/detect/version.js';
import { DEFAULT_CONFIG, DriftConfigSchema } from '../dist/config/schema.js';

describe('version normalisation', () => {
  test('strips range operators and prefixes', () => {
    assert.equal(normalizeVersion('^1.2.3'), '1.2.3');
    assert.equal(normalizeVersion('~2.0.0'), '2.0.0');
    assert.equal(normalizeVersion('>=3.1.4'), '3.1.4');
    assert.equal(normalizeVersion('v4.0.0'), '4.0.0');
    assert.equal(normalizeVersion('  1.0.0  '), '1.0.0');
  });

  test('takes the lower bound of a compound range', () => {
    assert.equal(normalizeVersion('>=2.0.0 <3.0.0'), '2.0.0');
    assert.equal(normalizeVersion('>=1.5,<2'), '1.5.0');
  });

  test('handles ecosystem-specific forms', () => {
    assert.equal(normalizeVersion('~> 4.1'), '4.1.0');
    assert.equal(normalizeVersion('v1.2.3+incompatible'), '1.2.3');
    assert.equal(normalizeVersion('[1.0.0]'), '1.0.0');
  });

  test('returns null for things that are not versions', () => {
    assert.equal(normalizeVersion('*'), null);
    assert.equal(normalizeVersion('latest'), null);
    assert.equal(normalizeVersion('git+https://github.com/a/b'), null);
    assert.equal(normalizeVersion('workspace:*'), null);
    assert.equal(normalizeVersion(null), null);
  });
});

describe('bump classification', () => {
  test('classifies the standard cases', () => {
    assert.equal(classifyBump('1.0.0', '2.0.0'), 'major');
    assert.equal(classifyBump('1.0.0', '1.1.0'), 'minor');
    assert.equal(classifyBump('1.0.0', '1.0.1'), 'patch');
    assert.equal(classifyBump(null, '1.0.0'), 'added');
    assert.equal(classifyBump('1.0.0', null), 'removed');
  });

  test('treats a downgrade by major as a major move', () => {
    assert.equal(classifyBump('2.0.0', '1.0.0'), 'major');
  });

  test('flags 0.x minor bumps as breaking per semver section 4', () => {
    assert.ok(isZeroVerBreaking('0.1.0', '0.2.0'));
    assert.ok(!isZeroVerBreaking('0.1.0', '0.1.1'));
    assert.ok(!isZeroVerBreaking('1.1.0', '1.2.0'));
  });
});

describe('npm detection', () => {
  test('detects a version bump in package.json', () => {
    const changes = detectChanges([
      {
        path: 'package.json',
        before: JSON.stringify({ dependencies: { express: '^4.18.0' } }),
        after: JSON.stringify({ dependencies: { express: '^5.0.0' } }),
      },
    ]);

    assert.equal(changes.length, 1);
    assert.equal(changes[0]?.name, 'express');
    assert.equal(changes[0]?.from, '4.18.0');
    assert.equal(changes[0]?.to, '5.0.0');
    assert.equal(changes[0]?.bump, 'major');
    assert.equal(changes[0]?.kind, 'runtime');
  });

  test('distinguishes dev dependencies', () => {
    const changes = detectChanges([
      {
        path: 'package.json',
        before: JSON.stringify({ devDependencies: { vitest: '1.0.0' } }),
        after: JSON.stringify({ devDependencies: { vitest: '2.0.0' } }),
      },
    ]);
    assert.equal(changes[0]?.kind, 'dev');
  });

  test('ignores a range change that resolves to the same version', () => {
    const changes = detectChanges([
      {
        path: 'package.json',
        before: JSON.stringify({ dependencies: { lodash: '^4.17.21' } }),
        after: JSON.stringify({ dependencies: { lodash: '>=4.17.21' } }),
      },
    ]);
    assert.equal(changes.length, 0, 'range churn is not a dependency change');
  });

  test('parses lockfile v3 install paths, including scoped packages', () => {
    const before = JSON.stringify({
      packages: { 'node_modules/@scope/pkg': { version: '1.0.0' } },
    });
    const after = JSON.stringify({
      packages: { 'node_modules/@scope/pkg': { version: '2.0.0' } },
    });

    const changes = detectChanges([{ path: 'package-lock.json', before, after }]);
    assert.equal(changes[0]?.name, '@scope/pkg');
    assert.equal(changes[0]?.kind, 'transitive');
  });

  test('prefers the manifest over the lockfile for the same package', () => {
    const changes = detectChanges([
      {
        path: 'package-lock.json',
        before: JSON.stringify({ packages: { 'node_modules/express': { version: '4.18.0' } } }),
        after: JSON.stringify({ packages: { 'node_modules/express': { version: '5.0.0' } } }),
      },
      {
        path: 'package.json',
        before: JSON.stringify({ dependencies: { express: '^4.18.0' } }),
        after: JSON.stringify({ dependencies: { express: '^5.0.0' } }),
      },
    ]);

    assert.equal(changes.length, 1, 'the same bump in two files is one change');
    assert.equal(changes[0]?.kind, 'runtime', 'manifest kind wins over lockfile guess');
    assert.equal(changes[0]?.manifestPath, 'package.json');
  });

  test('survives malformed JSON without throwing', () => {
    assert.doesNotThrow(() =>
      detectChanges([{ path: 'package.json', before: '{ broken', after: '{"dependencies":{}}' }]),
    );
  });
});

describe('python detection', () => {
  test('preserves direct provenance across a source .in file and compiled pins', () => {
    const header = '# This file was autogenerated by uv pip compile docs/requirements.in\n';
    const changes = detectChanges([
      {
        path: 'docs/requirements.in',
        before: 'pydantic==2.10.0\nsphinx==7.0.0\n',
        after: 'pydantic==2.11.0\nsphinx==8.0.0\n',
      },
      {
        path: 'docs/requirements.txt',
        before:
          header +
          'pydantic==2.10.0\n    # via -r docs/requirements.in\n' +
          'pydantic-core==2.27.0\n    # via pydantic\n' +
          'snowballstemmer==2.2.0\n    # via sphinx\n',
        after:
          header +
          'pydantic==2.11.0\n    # via -r docs/requirements.in\n' +
          'pydantic-core==2.33.0\n    # via pydantic\n' +
          'snowballstemmer==3.0.0\n    # via sphinx\n',
      },
    ]);

    const byName = new Map(changes.map((change) => [change.name, change]));
    assert.equal(byName.get('pydantic')?.kind, 'runtime');
    assert.equal(byName.get('pydantic')?.manifestPath, 'docs/requirements.in');
    assert.equal(byName.get('pydantic-core')?.kind, 'transitive');
    assert.equal(byName.get('snowballstemmer')?.kind, 'transitive');
  });

  test('parses requirements.txt with markers and extras', () => {
    const changes = detectChanges([
      {
        path: 'requirements.txt',
        before: 'Django==4.2.0\nrequests[security]>=2.28.0 ; python_version>="3.8"\n# comment',
        after: 'Django==5.0.0\nrequests[security]>=2.28.0 ; python_version>="3.8"',
      },
    ]);

    assert.equal(changes.length, 1);
    assert.equal(changes[0]?.name, 'django', 'PEP 503 normalises the name');
    assert.equal(changes[0]?.from, '4.2.0');
    assert.equal(changes[0]?.to, '5.0.0');
  });

  test('parses poetry dependency tables', () => {
    const changes = detectChanges([
      {
        path: 'pyproject.toml',
        before: '[tool.poetry.dependencies]\npython = "^3.11"\nflask = "^2.3.0"\n',
        after: '[tool.poetry.dependencies]\npython = "^3.11"\nflask = "^3.0.0"\n',
      },
    ]);

    assert.equal(changes.length, 1, 'the python interpreter constraint is not a package');
    assert.equal(changes[0]?.name, 'flask');
    assert.equal(changes[0]?.bump, 'major');
  });

  test('parses PEP 621 project dependencies', () => {
    const changes = detectChanges([
      {
        path: 'pyproject.toml',
        before: '[project]\ndependencies = [\n  "httpx>=0.24.0",\n]\n',
        after: '[project]\ndependencies = [\n  "httpx>=0.27.0",\n]\n',
      },
    ]);
    assert.equal(changes[0]?.name, 'httpx');
    assert.equal(changes[0]?.to, '0.27.0');
  });
});

describe('go detection', () => {
  test('respects // indirect markers', () => {
    const before = `module example.com/x

require (
	github.com/gin-gonic/gin v1.9.0
	golang.org/x/sys v0.1.0 // indirect
)`;
    const after = before.replace('v1.9.0', 'v1.10.0').replace('v0.1.0', 'v0.2.0');

    const changes = detectChanges([{ path: 'go.mod', before, after }]);
    const gin = changes.find((c) => c.name === 'github.com/gin-gonic/gin');
    const sys = changes.find((c) => c.name === 'golang.org/x/sys');

    assert.equal(gin?.kind, 'runtime');
    assert.equal(sys?.kind, 'transitive');
  });
});

describe('maven detection', () => {
  test('resolves ${property} version references', () => {
    const pom = (version: string) => `<project>
  <properties><spring.version>${version}</spring.version></properties>
  <dependencies>
    <dependency>
      <groupId>org.springframework</groupId>
      <artifactId>spring-core</artifactId>
      <version>\${spring.version}</version>
    </dependency>
  </dependencies>
</project>`;

    const changes = detectChanges([{ path: 'pom.xml', before: pom('5.3.0'), after: pom('6.0.0') }]);
    assert.equal(changes[0]?.name, 'org.springframework:spring-core');
    assert.equal(changes[0]?.bump, 'major');
  });

  test('classifies test-scoped dependencies as dev', () => {
    const pom = (version: string) => `<project><dependencies><dependency>
      <groupId>junit</groupId><artifactId>junit</artifactId>
      <version>${version}</version><scope>test</scope>
    </dependency></dependencies></project>`;

    const changes = detectChanges([{ path: 'pom.xml', before: pom('4.12'), after: pom('4.13') }]);
    assert.equal(changes[0]?.kind, 'dev');
  });
});

describe('cargo and rubygems detection', () => {
  test('parses cargo inline tables', () => {
    const changes = detectChanges([
      {
        path: 'Cargo.toml',
        before: '[dependencies]\nserde = { version = "1.0.150", features = ["derive"] }\n',
        after: '[dependencies]\nserde = { version = "1.0.200", features = ["derive"] }\n',
      },
    ]);
    assert.equal(changes[0]?.name, 'serde');
    assert.equal(changes[0]?.to, '1.0.200');
  });

  test('parses Gemfile group blocks', () => {
    const gemfile = (version: string) => `source "https://rubygems.org"
gem "rails", "~> 7.0"
group :development, :test do
  gem "rspec", "${version}"
end`;

    const changes = detectChanges([
      { path: 'Gemfile', before: gemfile('3.11.0'), after: gemfile('3.12.0') },
    ]);
    assert.equal(changes[0]?.name, 'rspec');
    assert.equal(changes[0]?.kind, 'dev');
  });
});

describe('triage', () => {
  const change = {
    name: 'express',
    ecosystem: 'npm' as const,
    from: '4.0.0',
    to: '5.0.0',
    kind: 'runtime' as const,
    bump: 'major' as const,
    manifestPath: 'package.json',
  };

  test('accepts a major runtime bump by default', () => {
    const { actionable } = triage([change], DEFAULT_CONFIG);
    assert.equal(actionable.length, 1);
  });

  test('records a reason for everything it skips', () => {
    const config = DriftConfigSchema.parse({ ignore: ['express'] });
    const { actionable, skipped } = triage([change], config);

    assert.equal(actionable.length, 0);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0]!.reason, /ignore/);
  });

  test('lets 0.x minor bumps through even when minor is disabled', () => {
    const config = DriftConfigSchema.parse({ triggerOn: { minor: false } });
    const zeroVer = { ...change, from: '0.1.0', to: '0.2.0', bump: 'minor' as const };

    const { actionable } = triage([zeroVer], config);
    assert.equal(actionable.length, 1, '0.x minors are breaking under semver section 4');
  });

  test('dev dependencies are triaged by default, and can be turned off', () => {
    const dev = { ...change, kind: 'dev' as const };
    assert.equal(triage([dev], DEFAULT_CONFIG).actionable.length, 1);

    const config = DriftConfigSchema.parse({ triggerOn: { dev: false } });
    assert.equal(triage([dev], config).actionable.length, 0);
  });
});
