import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parserFor, detectChanges } from '../dist/detect/index.js';
import {
  parseLockfilePlatforms,
  resolveGemIdentity,
} from '../dist/detect/ecosystems/rubygems-identity.js';
import { lookupVersions } from '../dist/upgrade/versions.js';
import { directDependencies } from '../dist/upgrade/scan.js';
import { PACKAGE_MANAGERS } from '../dist/detect/package-manager.js';
import { clearHttpCache } from '../dist/util/http.js';

/**
 * RubyGems publishes `google-protobuf 4.36.0`, not `google-protobuf
 * 4.36.0-x86_64-linux-gnu`. The second string is a version *and* a
 * `Gem::Platform`, and reading it as a version manufactures a release that
 * does not exist — which then makes the platform-generic gem of the same
 * version look like an available upgrade.
 *
 * The opposite mistake is just as bad: `1.0.0-rc1` and `4.0.0.beta1` are real
 * `Gem::Version` spellings, and stripping them would silently move a
 * dependency onto a different release. So these tests pin both directions.
 */

const LOCKFILE = `GEM
  remote: https://rubygems.org/
  specs:
    google-protobuf (4.36.0-x86_64-linux-gnu)
    prometheus-client-mmap (1.6.1-x86_64-linux-gnu)
    some-gem (4.0.0.beta1)
    other-gem (1.0.0-rc1)
    java-gem (2.3.4-java)
    plain-gem (2.0.0)

PLATFORMS
  ruby
  x86_64-linux-gnu

DEPENDENCIES
  google-protobuf
`;

const realFetch = globalThis.fetch;

function stubFetch(responder: (url: string) => Response): void {
  clearHttpCache();
  globalThis.fetch = ((input: string | URL | Request) =>
    Promise.resolve(responder(String(input)))) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  clearHttpCache();
});

describe('RubyGems platform is not part of the version', () => {
  test('the lockfile PLATFORMS section is read', () => {
    assert.deepEqual(parseLockfilePlatforms(LOCKFILE), ['x86_64-linux-gnu']);
  });

  test('platform suffixes split off the version', () => {
    assert.deepEqual(resolveGemIdentity('4.36.0-x86_64-linux-gnu', ['x86_64-linux-gnu']), {
      version: '4.36.0',
      platform: 'x86_64-linux-gnu',
    });
    assert.deepEqual(resolveGemIdentity('1.6.1-x86_64-linux-gnu', ['x86_64-linux-gnu']), {
      version: '1.6.1',
      platform: 'x86_64-linux-gnu',
    });
  });

  test('platforms are recognised structurally when PLATFORMS does not list them', () => {
    // A lockfile committed from one machine is often checked out on another.
    for (const [token, version, platform] of [
      ['0.5.5-x86_64-linux', '0.5.5', 'x86_64-linux'],
      ['1.1.0-arm64-darwin', '1.1.0', 'arm64-darwin'],
      ['1.1.0-arm64-darwin-23', '1.1.0', 'arm64-darwin-23'],
      ['3.2.1-aarch64-linux-musl', '3.2.1', 'aarch64-linux-musl'],
      ['2.3.4-java', '2.3.4', 'java'],
      ['1.2.3-x64-mingw-ucrt', '1.2.3', 'x64-mingw-ucrt'],
    ] as const) {
      assert.deepEqual(resolveGemIdentity(token), { version, platform }, token);
    }
  });

  test('real version qualifiers are never mistaken for platforms', () => {
    for (const raw of ['4.0.0.beta1', '1.0.0-rc1', '2.0.0-alpha.1', '19.4.0.pre.rc1', '1.0.0-pre1']) {
      assert.deepEqual(resolveGemIdentity(raw, ['x86_64-linux-gnu']), { version: raw }, raw);
    }
  });

  test('the Bundler lockfile parser records version and platform separately', () => {
    const parsed = parserFor('Gemfile.lock')!.parse(LOCKFILE, 'Gemfile.lock');

    assert.equal(parsed.get('google-protobuf')?.version, '4.36.0');
    assert.equal(parsed.get('google-protobuf')?.platform, 'x86_64-linux-gnu');
    assert.equal(parsed.get('prometheus-client-mmap')?.version, '1.6.1');
    assert.equal(parsed.get('prometheus-client-mmap')?.platform, 'x86_64-linux-gnu');
    assert.equal(parsed.get('java-gem')?.version, '2.3.4');
    assert.equal(parsed.get('java-gem')?.platform, 'java');

    assert.equal(parsed.get('some-gem')?.version, '4.0.0.beta1');
    assert.equal(parsed.get('some-gem')?.platform, undefined);
    assert.equal(parsed.get('other-gem')?.version, '1.0.0-rc1');
    assert.equal(parsed.get('other-gem')?.platform, undefined);
    assert.equal(parsed.get('plain-gem')?.version, '2.0.0');
  });

  test('installing a platform build of the same version is not a dependency change', () => {
    const generic = LOCKFILE.replace('google-protobuf (4.36.0-x86_64-linux-gnu)', 'google-protobuf (4.36.0)');
    const changes = detectChanges([
      { path: 'Gemfile.lock', before: LOCKFILE, after: generic },
    ]);

    assert.deepEqual(changes.filter((change) => change.name === 'google-protobuf'), []);
  });

  test('a platform gem already at the registry latest is not an upgrade', async () => {
    stubFetch(() =>
      new Response(JSON.stringify([{ number: '4.36.0' }, { number: '4.35.0' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const bundler = PACKAGE_MANAGERS.find((manager) => manager.id === 'bundler')!;
    const files = new Map([
      ['/repo/Gemfile', "source 'https://rubygems.org'\ngem 'google-protobuf'\n"],
      ['/repo/Gemfile.lock', LOCKFILE],
    ]);
    const deps = await directDependencies(
      '/repo',
      { manager: bundler, dir: '', manifestPath: 'Gemfile', lockfilePath: 'Gemfile.lock' },
      true,
      {
        readFile: async (path: string) => files.get(path) ?? null,
        readDirectory: async () => [],
        isDirectory: async () => false,
      },
    );

    const protobuf = deps.find((dep) => dep.name === 'google-protobuf');
    assert.equal(protobuf?.current, '4.36.0');

    const lookup = await lookupVersions({
      name: 'google-protobuf',
      ecosystem: 'rubygems',
      current: protobuf!.current!,
      range: protobuf!.range ?? '',
    });

    assert.equal(lookup.outcome, 'up-to-date');
  });
});
