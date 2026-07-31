import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSurfaceDiff,
  jarUrl,
  parseCargoPublicApi,
  parseCoordinate,
  parseGoDoc,
  parseJapicmp,
  parsePythonSurface,
  surfaceProviderFor,
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

describe('go doc output', () => {
  const sample = `package client // import "example.com/client"

Package client talks to the service.

const DefaultTimeout = 30

func Dial(address string) (*Conn, error)

func Version() string

type Conn struct {
	Addr    string
	Timeout int
	// contains filtered or unexported fields
}
    Conn is an open connection.

func (c *Conn) Close() error

func (c *Conn) Send(b []byte) (int, error)

type Option interface {
	Apply(*Conn)
}
`;

  test('records exported declarations, and only those', () => {
    const api = parseGoDoc(sample);
    assert.deepEqual([...api.keys()].sort(), ['Conn', 'DefaultTimeout', 'Dial', 'Option', 'Version']);
  });

  test('classifies by keyword', () => {
    const api = parseGoDoc(sample);
    assert.equal(api.get('Dial')!.kind, 'function');
    assert.equal(api.get('Conn')!.kind, 'interface');
    assert.equal(api.get('DefaultTimeout')!.kind, 'variable');
  });

  test('methods and struct fields are members of their type', () => {
    const api = parseGoDoc(sample);
    assert.deepEqual(api.get('Conn')!.members.sort(), ['Addr', 'Close', 'Send', 'Timeout']);
    assert.deepEqual(api.get('Option')!.members, ['Apply']);
  });

  test('prose inside a type body is not mistaken for a field', () => {
    assert.equal(parseGoDoc(sample).get('Conn')!.members.includes('Conn'), false);
  });

  test('a dropped method reads as a member removal, not a missing export', () => {
    const after = parseGoDoc(sample.replace('func (c *Conn) Send(b []byte) (int, error)\n', ''));
    const changes = diffSurfaces(parseGoDoc(sample), after);
    assert.deepEqual(
      changes.map((c) => [c.kind, c.symbol]),
      [['member-removed', 'Conn.Send']],
    );
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
    assert.match(outcome.remedy ?? '', /cargo install cargo-public-api/);
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

describe('a computed surface that does run', () => {
  const goDoc = (symbols: string) => `package client // import "example.com/client"\n\n${symbols}\n`;

  const exec = (docs: Record<string, string>) =>
    (async (command: string, args: readonly string[], options?: { cwd?: string }) => {
      if (command === 'go' && args[0] === 'version') return { code: 0, stdout: 'go1.22', stderr: '' };
      if (command === 'go' && args[0] === 'get') return { code: 0, stdout: '', stderr: '' };
      if (command === 'go' && args[0] === 'doc') {
        const version = /probe-(v[\w.]+)/.exec(options?.cwd ?? '')?.[1] ?? '';
        return { code: 0, stdout: docs[version] ?? '', stderr: '' };
      }
      return { code: 127, stdout: '', stderr: 'unexpected', failure: 'not-found' as const };
    });

  test('produces the same SurfaceChange shape any other source does', async () => {
    const outcome = await computeSurfaceDiff(
      change({ ecosystem: 'go', name: 'example.com/client', from: 'v1.0.0', to: 'v2.0.0' }),
      {
        logger,
        exec: exec({
          'v1.0.0': goDoc('func Dial(address string) (*Conn, error)\n\nfunc Legacy() error'),
          'v2.0.0': goDoc('func Dial(address string, opts ...Option) (*Conn, error)'),
        }),
      },
    );

    assert.equal(outcome.available, true);
    if (!outcome.available) return;
    assert.equal(outcome.tool, 'go doc');
    assert.equal(outcome.weight, 1);
    assert.deepEqual(
      outcome.changes.map((c) => [c.kind, c.symbol]).sort(),
      [
        ['export-removed', 'Legacy'],
        ['signature-changed', 'Dial'],
      ].sort(),
    );
  });

  test('a version the proxy does not have is distinguished from a build failure', async () => {
    const outcome = await computeSurfaceDiff(
      change({ ecosystem: 'go', name: 'example.com/client', from: 'v1.0.0', to: 'v9.9.9' }),
      {
        logger,
        exec: async (command: string, args: readonly string[]) => {
          if (args[0] === 'version') return { code: 0, stdout: 'go1.22', stderr: '' };
          if (args[0] === 'get') return { code: 1, stdout: '', stderr: 'unknown revision v9.9.9' };
          return { code: 0, stdout: '', stderr: '' };
        },
      },
    );

    assert.equal(outcome.available, false);
    if (outcome.available) return;
    assert.equal(outcome.reason, 'version-unavailable');
    assert.match(outcome.detail, /private/);
  });
});
