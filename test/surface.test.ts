import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSurfaceDiff,
  jarUrl,
  parseCargoPublicApi,
  parseCoordinate,
  parseGoApiDump,
  diffGoApi,
  goVersionFromModuleFile,
  goVersionFromWorkflow,
  requiredGoVersion,
  goRemedy,
  DEFAULT_GO_VERSION,
  parseJapicmp,
  parsePythonSurface,
  surfaceProviderFor,
  resetGoSurfaceCache,
} from '../dist/evidence/surface/index.js';
import { diffSurfaces } from '../dist/evidence/type-surface.js';
import { createLogger } from '../dist/util/logger.js';

/**
 * Computed API-surface diffing per ecosystem.
 *
 * The tools are external and the toolchains are not installed here, so what is
 * tested is what Drift actually owns: reading each tool's output into the one
 * shared shape, and reporting a *stated reason* rather than a silent absence
 * when a tool cannot run.
 */

const logger = createLogger('silent');

const change = (over: Record<string, unknown> = {}) =>
  ({
    name: 'serde',
    ecosystem: 'cargo',
    from: '1.0.0',
    to: '2.0.0',
    kind: 'runtime',
    bump: 'major',
    manifestPath: 'Cargo.toml',
    rawFrom: '1.0.0',
    rawTo: '2.0.0',
    ...over,
  }) as never;

describe('cargo public-api output', () => {
  const sample = `
pub mod serde_json
pub struct serde_json::Value
pub fn serde_json::Value::as_str(&self) -> Option<&str>
pub fn serde_json::Value::as_u64(&self) -> Option<u64>
pub enum serde_json::Error
pub fn serde_json::from_str<'a, T>(s: &'a str) -> Result<T, Error>
impl serde::Serialize for serde_json::Value
`;

  test('reads each public item as one entry, keyed by its path', () => {
    const api = parseCargoPublicApi(sample);
    assert.ok(api.has('serde_json::Value'));
    assert.ok(api.has('serde_json::from_str'));
    assert.equal(api.get('serde_json::Value')!.kind, 'class');
    assert.equal(api.get('serde_json::Error')!.kind, 'enum');
    assert.equal(api.get('serde_json')!.kind, 'namespace');
  });

  test('splits on `::` correctly rather than at the first colon', () => {
    assert.equal(parseCargoPublicApi(sample).get('serde_json::from_str')!.name, 'serde_json::from_str');
  });

  test('attributes methods to the type that owns them', () => {
    const api = parseCargoPublicApi(sample);
    assert.deepEqual(api.get('serde_json::Value')!.members, ['as_str', 'as_u64']);
    assert.equal(api.has('serde_json::Value::as_str'), false);
  });

  test('ignores impl blocks, which name no new public item', () => {
    assert.equal(parseCargoPublicApi(sample).has('serde::Serialize'), false);
  });

  test('a removed item and a changed signature both survive the diff', () => {
    const before = parseCargoPublicApi(sample);
    const after = parseCargoPublicApi(`
pub mod serde_json
pub struct serde_json::Value
pub fn serde_json::Value::as_str(&self) -> Option<&str>
pub enum serde_json::Error
pub fn serde_json::from_str<'a, T>(s: &'a str, strict: bool) -> Result<T, Error>
`);

    const changes = diffSurfaces(before, after);
    assert.ok(changes.some((c) => c.kind === 'member-removed' && c.symbol === 'serde_json::Value.as_u64'));
    assert.ok(changes.some((c) => c.kind === 'signature-changed' && c.symbol === 'serde_json::from_str'));
  });
});

describe('go module API extraction', () => {
  // The extractor's output, as it arrives on stdout. Written by hand rather
  // than captured, so a change to the shape it emits fails here loudly.
  const dump = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      Module: 'example.com/client',
      Platforms: ['linux/amd64', 'windows/amd64'],
      Packages: ['example.com/client', 'example.com/client/tls'],
      Failures: [],
      Symbols: [
        {
          Key: 'example.com/client.Dial',
          Name: 'Dial',
          Pkg: 'example.com/client',
          PkgName: 'client',
          Kind: 'function',
          Signatures: ['func Dial(address string) (*Conn, error)'],
          Members: [],
          RequiredMembers: [],
          Platforms: ['linux/amd64', 'windows/amd64'],
        },
        {
          Key: 'example.com/client.Conn',
          Name: 'Conn',
          Pkg: 'example.com/client',
          PkgName: 'client',
          Kind: 'class',
          Signatures: ['type Conn struct'],
          Members: ['Addr', 'Close', 'Timeout'],
          RequiredMembers: [],
          Platforms: ['linux/amd64', 'windows/amd64'],
        },
        {
          Key: 'example.com/client.Option',
          Name: 'Option',
          Pkg: 'example.com/client',
          PkgName: 'client',
          Kind: 'interface',
          Signatures: ['type Option interface'],
          Members: ['Apply'],
          RequiredMembers: ['Apply'],
          Platforms: ['linux/amd64', 'windows/amd64'],
        },
        {
          Key: 'example.com/client.DefaultTimeout',
          Name: 'DefaultTimeout',
          Pkg: 'example.com/client',
          PkgName: 'client',
          Kind: 'variable',
          Signatures: ['const DefaultTimeout = 30'],
          Members: [],
          RequiredMembers: [],
          Platforms: ['linux/amd64', 'windows/amd64'],
        },
      ],
      ...over,
    });

  const parse = (json: string) => {
    const api = parseGoApiDump(json);
    assert.ok(api, 'the extractor output should parse');
    return api!;
  };

  test('reads packages, symbols, and the platforms each was seen on', () => {
    const api = parse(dump());
    assert.deepEqual(api.packages, ['example.com/client', 'example.com/client/tls']);
    assert.equal(api.symbols.size, 4);
    assert.deepEqual(api.symbols.get('example.com/client.Conn')!.members, ['Addr', 'Close', 'Timeout']);
  });

  test('malformed output is a stated absence, not a thrown error', () => {
    assert.equal(parseGoApiDump('go: downloading something'), null);
    assert.equal(parseGoApiDump('{"Module":"x"}'), null);
  });

  test('a removed package is reported once, not once per symbol it held', () => {
    const before = parse(dump());
    const after = parse(dump({ Packages: ['example.com/client'] }));
    const { changes } = diffGoApi(before, after);
    assert.deepEqual(
      changes.map((c) => [c.kind, c.symbol]),
      [['package-removed', 'example.com/client/tls']],
    );
  });

  test('a dropped method reads as a member removal on its type', () => {
    const before = parse(dump());
    const after = parse(
      dump({
        Symbols: JSON.parse(dump()).Symbols.map((s: Record<string, unknown>) =>
          s.Key === 'example.com/client.Conn' ? { ...s, Members: ['Addr', 'Timeout'] } : s,
        ),
      }),
    );
    const { changes } = diffGoApi(before, after);
    assert.deepEqual(
      changes.map((c) => [c.kind, c.symbol]),
      [['member-removed', 'client.Conn.Close']],
    );
  });

  test('a method added to an interface is breaking for implementors', () => {
    const before = parse(dump());
    const after = parse(
      dump({
        Symbols: JSON.parse(dump()).Symbols.map((s: Record<string, unknown>) =>
          s.Key === 'example.com/client.Option'
            ? { ...s, Members: ['Apply', 'Name'], RequiredMembers: ['Apply', 'Name'] }
            : s,
        ),
      }),
    );
    const { changes } = diffGoApi(before, after);
    assert.deepEqual(
      changes.map((c) => [c.kind, c.symbol]),
      [['member-now-required', 'client.Option.Name']],
    );
  });

  test('losing a platform is a removal that names the platform', () => {
    const before = parse(dump());
    const after = parse(
      dump({
        Symbols: JSON.parse(dump()).Symbols.map((s: Record<string, unknown>) =>
          s.Key === 'example.com/client.Dial' ? { ...s, Platforms: ['linux/amd64'] } : s,
        ),
      }),
    );
    const { changes } = diffGoApi(before, after);
    assert.equal(changes.length, 1);
    assert.equal(changes[0]!.kind, 'export-removed');
    assert.match(changes[0]!.detail, /no longer available on windows\/amd64/);
    assert.match(changes[0]!.detail, /remains on linux\/amd64/);
  });

  test('additions are collected, and are never reported as changes', () => {
    const before = parse(dump({ Packages: ['example.com/client'] }));
    const after = parse(dump());
    const { changes, additions } = diffGoApi(before, after);
    assert.deepEqual(changes, []);
    assert.deepEqual(additions, [{ kind: 'package-added', symbol: 'example.com/client/tls' }]);
  });

  test('a flood of changed constant values collapses into one counted finding', () => {
    const constants = Array.from({ length: 40 }, (_, i) => ({
      Key: `example.com/client.C${i}`,
      Name: `C${i}`,
      Pkg: 'example.com/client',
      PkgName: 'client',
      Kind: 'variable',
      Signatures: [`const C${i} = 0x1`],
      Members: [],
      RequiredMembers: [],
      Platforms: ['linux/amd64'],
    }));
    const before = parse(dump({ Symbols: constants }));
    const after = parse(
      dump({ Symbols: constants.map((c) => ({ ...c, Signatures: [`const ${c.Name} = 0x2`] })) }),
    );

    const { changes } = diffGoApi(before, after);
    assert.equal(changes.length, 1);
    assert.match(changes[0]!.detail, /40 exported constants changed value/);
  });

  test('a constant whose type changed is a signature change, not a value change', () => {
    const before = parse(dump());
    const after = parse(
      dump({
        Symbols: JSON.parse(dump()).Symbols.map((s: Record<string, unknown>) =>
          s.Key === 'example.com/client.DefaultTimeout'
            ? { ...s, Signatures: ['const DefaultTimeout time.Duration = 30'] }
            : s,
        ),
      }),
    );
    const { changes } = diffGoApi(before, after);
    assert.deepEqual(
      changes.map((c) => [c.kind, c.symbol]),
      [['signature-changed', 'client.DefaultTimeout']],
    );
  });
});

describe('go version requirements', () => {
  test('the toolchain directive wins over the language directive', () => {
    assert.equal(goVersionFromModuleFile('module x\n\ngo 1.21\n\ntoolchain go1.24.3\n'), '1.24.3');
    assert.equal(goVersionFromModuleFile('module x\n\ngo 1.23.1\n'), '1.23.1');
    assert.equal(goVersionFromModuleFile('module x\n'), null);
  });

  test('a workflow go-version is read, and a matrix expression is not mistaken for one', () => {
    assert.equal(goVersionFromWorkflow("      - uses: actions/setup-go\n        with:\n          go-version: '1.24'\n"), '1.24');
    assert.equal(goVersionFromWorkflow('          go-version: 1.22.x\n'), '1.22');
    assert.equal(goVersionFromWorkflow('          go-version: ${{ matrix.go }}\n'), null);
  });

  test('go.work is consulted before go.mod', async () => {
    const files: Record<string, string> = {
      'go.work': 'go 1.25\n\nuse ./a\n',
      'go.mod': 'module x\n\ngo 1.19\n',
    };
    const found = await requiredGoVersion(async (path) => files[path] ?? null);
    assert.deepEqual(found, { version: '1.25', source: 'go.work' });
  });

  test('with nothing to read, the default is returned and labelled as one', async () => {
    const found = await requiredGoVersion(async () => null);
    assert.equal(found.version, DEFAULT_GO_VERSION);
    assert.equal(found.source, 'Drift default');
  });

  test('the remedy names the version the repository actually asks for', async () => {
    const requirement = { version: '1.24', source: 'go.mod' };
    assert.match(goRemedy(requirement, false), /Install Go 1\.24/);
    assert.match(goRemedy(requirement, true), /actions\/setup-go/);
    assert.match(goRemedy(requirement, true), /go-version: '1\.24'/);
  });
});

describe('japicmp output', () => {
  const sample = `Comparing source compatibility of new.jar against old.jar
---! REMOVED CLASS: PUBLIC com.example.Legacy
***! MODIFIED CLASS: PUBLIC com.example.Client  (not serializable)
	---! REMOVED METHOD: PUBLIC void close()
	***! MODIFIED METHOD: PUBLIC java.lang.String send(byte[])
	+++  NEW METHOD: PUBLIC void flush()
===  UNCHANGED CLASS: PUBLIC com.example.Util
`;

  test('reports removals and modifications', () => {
    const changes = parseJapicmp(sample);
    assert.deepEqual(
      changes.map((c) => [c.kind, c.symbol]),
      [
        ['export-removed', 'com.example.Legacy'],
        ['member-removed', 'com.example.Client.close'],
        ['signature-changed', 'com.example.Client.send'],
      ],
    );
  });

  test('never reports an addition, which cannot break a caller', () => {
    assert.equal(parseJapicmp(sample).some((c) => c.symbol.endsWith('flush')), false);
  });

  test('members are attributed to the class they were nested under', () => {
    assert.ok(parseJapicmp(sample).every((c) => !c.symbol.startsWith('.')));
  });
});

describe('maven coordinates', () => {
  test('derive the Central URL without a search call', () => {
    const coordinate = parseCoordinate('com.google.guava:guava')!;
    assert.equal(
      jarUrl(coordinate, '33.0.0-jre'),
      'https://repo1.maven.org/maven2/com/google/guava/guava/33.0.0-jre/guava-33.0.0-jre.jar',
    );
  });

  test('a name that is not a coordinate is rejected rather than guessed at', () => {
    assert.equal(parseCoordinate('guava'), null);
  });
});

describe('python symbol listing', () => {
  test('reads the helper script output into the shared shape', () => {
    const api = parsePythonSurface(
      JSON.stringify([
        { name: 'connect', kind: 'function', signature: 'def connect(url, timeout) defaults=1' },
        { name: 'Client', kind: 'class', signature: 'class Client(Base)', members: ['send', 'close'] },
      ]),
    )!;
    assert.equal(api.get('connect')!.kind, 'function');
    assert.deepEqual(api.get('Client')!.members, ['send', 'close']);
  });

  test('malformed output is null, not an empty surface', () => {
    // An empty surface would read as "everything was removed"; null degrades
    // to prose evidence instead.
    assert.equal(parsePythonSurface('not json'), null);
    assert.equal(parsePythonSurface('{"nope": true}'), null);
  });
});

describe('when a surface cannot be computed', () => {
  const missingTool = async () => ({ code: 1, stdout: '', stderr: 'not found', failure: 'not-found' as const });

  test('a missing toolchain is a named reason, not a silent absence', async () => {
    const outcome = await computeSurfaceDiff(change(), { logger, exec: missingTool });
    assert.equal(outcome.available, false);
    if (outcome.available) return;
    assert.equal(outcome.reason, 'tool-missing');
    assert.equal(outcome.tool, 'cargo public-api');
    assert.match(outcome.detail, /Cargo toolchain/);
    assert.match(outcome.remedy ?? '', /rustup|cargo/);
  });

  test('installed Cargo is distinguished from the missing public-api subcommand', async () => {
    const exec = async (_command: string, args: readonly string[]) => {
      if (args[0] === '--version') return { code: 0, stdout: 'cargo 1.91.1', stderr: '' };
      return { code: 101, stdout: '', stderr: 'error: no such command: `public-api`' };
    };

    const outcome = await computeSurfaceDiff(change(), { logger, exec });

    assert.equal(outcome.available, false);
    if (outcome.available) return;
    assert.equal(outcome.reason, 'tool-missing');
    assert.match(outcome.detail, /Rust API helper is missing/);
    assert.match(outcome.remedy ?? '', /Drift can install/);
    assert.deepEqual(outcome.install, {
      id: 'cargo-public-api',
      label: 'Install cargo-public-api',
      command: 'cargo',
      args: ['install', 'cargo-public-api'],
    });
  });

  test('uses the supplied environment for every cargo command', async () => {
    const env = { ...process.env, PATH: '/drift/cargo/bin' };
    const seen: string[] = [];
    const exec = async (_command: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
      assert.equal(options?.env?.PATH, '/drift/cargo/bin');
      seen.push(args.join(' '));
      if (args[0] === '--version') return { code: 0, stdout: 'cargo 1.91.1', stderr: '' };
      if (args[0] === 'public-api' && args[1] === '--version') {
        return { code: 0, stdout: 'cargo-public-api 0.50.0', stderr: '' };
      }
      return { code: 0, stdout: 'pub fn base64::encode<T: AsRef<[u8]>>(input: T) -> String\n', stderr: '' };
    };

    const outcome = await computeSurfaceDiff(change(), { logger, exec, env });

    assert.equal(outcome.available, true);
    assert.deepEqual(seen, ['--version', 'public-api --version', 'public-api --simplified --package serde', 'public-api --simplified --package serde']);
  });

  test('ecosystems with no computed surface say so plainly', async () => {
    const outcome = await computeSurfaceDiff(change({ ecosystem: 'rubygems', name: 'rails' }), {
      logger,
      exec: missingTool,
    });
    assert.equal(outcome.available, false);
    if (outcome.available) return;
    assert.equal(outcome.reason, 'unsupported-ecosystem');
    assert.match(outcome.detail, /prose evidence/);
  });

  test('ruby is left on prose deliberately', () => {
    assert.equal(surfaceProviderFor('rubygems'), undefined);
    assert.equal(surfaceProviderFor('npm'), undefined);
    assert.equal(surfaceProviderFor('cargo')!.tool, 'cargo public-api');
  });

  test('the python surface is weighted below the true computed diffs', () => {
    // 0.9 keeps a lone Python surface diff at `medium` confidence, which is
    // what stops it clearing a gate the .d.ts diff would.
    assert.equal(surfaceProviderFor('pypi')!.weight, 0.9);
    assert.equal(surfaceProviderFor('go')!.weight, 1);
    assert.equal(surfaceProviderFor('maven')!.weight, 1);
  });
});

describe('a computed Go surface that does run', () => {
  /**
   * A stand-in for the Go toolchain, speaking the protocol the provider uses:
   * probe, build the extractor once, download each version, extract each one.
   */
  const goToolchain = (dumps: Record<string, string>, over: Record<string, unknown> = {}) =>
    (async (command: string, args: readonly string[]) => {
      const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
      if (command !== 'go') return { code: 127, stdout: '', stderr: 'not go', failure: 'not-found' as const };
      if (args[0] === 'version') return ok('go version go1.24.3 darwin/arm64');
      if (args[0] === 'env') return ok('/tmp/gomodcache');
      if (args[0] === 'build') return ok('');
      if (args[0] === 'mod' && args[1] === 'download') {
        const version = /@(v[\w.+-]+)$/.exec(args[3] ?? '')?.[1] ?? '';
        if (over[version] !== undefined) return over[version] as never;
        return ok(JSON.stringify({ Path: 'example.com/client', Version: version, Dir: `/tmp/gomodcache/client@${version}` }));
      }
      if (args[0] === 'run') {
        const version = /client@(v[\w.+-]+)/.exec(args.join(' '))?.[1] ?? '';
        return ok(dumps[version] ?? '');
      }
      return { code: 1, stdout: '', stderr: `unexpected: go ${args.join(' ')}` };
    });

  const api = (symbols: Record<string, unknown>[]) =>
    JSON.stringify({
      Module: 'example.com/client',
      Platforms: ['linux/amd64'],
      Packages: ['example.com/client'],
      Failures: [],
      Symbols: symbols.map((s) => ({
        Pkg: 'example.com/client',
        PkgName: 'client',
        Kind: 'function',
        Members: [],
        RequiredMembers: [],
        Platforms: ['linux/amd64'],
        ...s,
      })),
    });

  const goChange = (over: Record<string, unknown> = {}) =>
    change({ ecosystem: 'go', name: 'example.com/client', from: 'v1.0.0', to: 'v2.0.0', ...over });

  test('produces the same SurfaceChange shape any other source does', async () => {
    resetGoSurfaceCache();
    const outcome = await computeSurfaceDiff(goChange(), {
      logger,
      exec: goToolchain({
        'v1.0.0': api([
          { Key: 'example.com/client.Dial', Name: 'Dial', Signatures: ['func Dial(address string) (*Conn, error)'] },
          { Key: 'example.com/client.Legacy', Name: 'Legacy', Signatures: ['func Legacy() error'] },
        ]),
        'v2.0.0': api([
          { Key: 'example.com/client.Dial', Name: 'Dial', Signatures: ['func Dial(address string, opts ...Option) (*Conn, error)'] },
        ]),
      }),
    });

    assert.equal(outcome.available, true);
    if (!outcome.available) return;
    assert.equal(outcome.weight, 1);
    assert.deepEqual(
      outcome.changes.map((c) => [c.kind, c.symbol]).sort(),
      [
        ['export-removed', 'client.Legacy'],
        ['signature-changed', 'client.Dial'],
      ].sort(),
    );
  });

  test('the citation names what was actually compared', async () => {
    resetGoSurfaceCache();
    const outcome = await computeSurfaceDiff(goChange(), {
      logger,
      exec: goToolchain({
        'v1.0.0': api([{ Key: 'example.com/client.Dial', Name: 'Dial', Signatures: ['func Dial()'] }]),
        'v2.0.0': api([{ Key: 'example.com/client.Dial', Name: 'Dial', Signatures: ['func Dial()'] }]),
      }),
    });

    assert.equal(outcome.available, true);
    if (!outcome.available) return;
    assert.match(outcome.locator, /1 package\(s\), 1 exported symbol\(s\)/);
    assert.match(outcome.locator, /platforms: /);
  });

  test('a version the proxy does not have is distinguished from a build failure', async () => {
    resetGoSurfaceCache();
    const outcome = await computeSurfaceDiff(goChange({ to: 'v9.9.9' }), {
      logger,
      exec: goToolchain(
        { 'v1.0.0': api([{ Key: 'example.com/client.Dial', Name: 'Dial', Signatures: ['func Dial()'] }]) },
        { 'v9.9.9': { code: 1, stdout: '', stderr: 'go: module example.com/client@v9.9.9: unknown revision v9.9.9' } },
      ),
    });

    assert.equal(outcome.available, false);
    if (outcome.available) return;
    assert.equal(outcome.reason, 'version-unavailable');
    assert.match(outcome.detail, /private/);
  });

  test('a missing toolchain says which Go version would fix it', async () => {
    resetGoSurfaceCache();
    const outcome = await computeSurfaceDiff(goChange(), {
      logger,
      exec: async () => ({ code: 127, stdout: '', stderr: 'not found', failure: 'not-found' as const }),
      readRepoFile: async (path) => (path === 'go.mod' ? 'module x\n\ngo 1.24\n' : null),
    });

    assert.equal(outcome.available, false);
    if (outcome.available) return;
    assert.equal(outcome.reason, 'tool-missing');
    assert.match(outcome.remedy ?? '', /Go 1\.24/);
  });

  test('uses the supplied environment for every go command', async () => {
    resetGoSurfaceCache();
    const env = { ...process.env, PATH: '/drift/go/bin' };
    const seen: string[] = [];
    const dumps = {
      'v1.0.0': api([{ Key: 'example.com/client.Dial', Name: 'Dial', Signatures: ['func Dial()'] }]),
      'v2.0.0': api([{ Key: 'example.com/client.Dial', Name: 'Dial', Signatures: ['func Dial()'] }]),
    };
    const base = goToolchain(dumps);
    const checking = (async (command: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
      if (command === 'go') {
        seen.push(args[0] ?? '');
        assert.equal(options?.env?.PATH, '/drift/go/bin');
      }
      return base(command, args);
    }) as typeof base;

    const outcome = await computeSurfaceDiff(goChange(), { logger, exec: checking, env });

    assert.equal(outcome.available, true);
    assert.deepEqual(seen, ['version', 'env', 'build', 'mod', 'run', 'mod', 'run']);
  });

  test('a module version is extracted once, however often it is asked for', async () => {
    resetGoSurfaceCache();
    let extractions = 0;
    const dumps = {
      'v1.0.0': api([{ Key: 'example.com/client.Dial', Name: 'Dial', Signatures: ['func Dial()'] }]),
      'v2.0.0': api([{ Key: 'example.com/client.Dial', Name: 'Dial', Signatures: ['func Dial(o Option)'] }]),
    };
    const base = goToolchain(dumps);
    const counting = (async (command: string, args: readonly string[], options?: unknown) => {
      if (args[0] === 'run') extractions++;
      return base(command, args, options as never);
    }) as typeof base;

    await computeSurfaceDiff(goChange(), { logger, exec: counting });
    await computeSurfaceDiff(goChange(), { logger, exec: counting });

    assert.equal(extractions, 2, 'the second comparison should be served from the cache');
  });
});
