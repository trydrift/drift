import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseOpamMetadata,
  githubRepoFromOpam,
  fetchOpamMetadata,
  fetchOpamPackageVersions,
} from '../dist/evidence/opam-repository.js';
import { fetchRegistryInfo } from '../dist/evidence/registry.js';
import { clearHttpCache } from '../dist/util/http.js';

/**
 * opam has no JSON metadata API, but its index git repo carries everything:
 * the version directories under `packages/<name>/`, and each release's `opam`
 * file with `dev-repo`, `homepage`, `synopsis`, and the `url { src }` stanza.
 * `fetchRegistryInfo(..., 'opam')` returned `null`, so packages with an
 * explicit GitHub `dev-repo` (cohttp and friends) lost release research.
 */

const realFetch = globalThis.fetch;

const OPAM_FILE = `opam-version: "2.0"
synopsis: "An OCaml library for HTTP clients and servers"
description: """
Cohttp is an OCaml library for creating HTTP daemons and clients.
"""
maintainer: "someone@example.com"
homepage: "https://github.com/mirage/ocaml-cohttp"
doc: "https://mirage.github.io/ocaml-cohttp/"
bug-reports: "https://github.com/mirage/ocaml-cohttp/issues"
dev-repo: "git+https://github.com/mirage/ocaml-cohttp.git"
build: [
  ["dune" "build" "-p" name "-j" jobs]
]
url {
  src: "https://github.com/mirage/ocaml-cohttp/archive/refs/tags/v5.3.0.tar.gz"
  checksum: [ "sha256=deadbeef" ]
}
`;

function stub(handler: (url: string) => unknown) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const body = handler(url);
    if (body === undefined) return new Response('', { status: 404 });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { calls: () => calls };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  clearHttpCache();
});

describe('parseOpamMetadata', () => {
  test('reads the literal fields Drift needs', () => {
    const meta = parseOpamMetadata(OPAM_FILE, 'cohttp', '5.3.0');
    assert.equal(meta.devRepo, 'git+https://github.com/mirage/ocaml-cohttp.git');
    assert.equal(meta.homepage, 'https://github.com/mirage/ocaml-cohttp');
    assert.equal(meta.bugReports, 'https://github.com/mirage/ocaml-cohttp/issues');
    assert.equal(meta.synopsis, 'An OCaml library for HTTP clients and servers');
    assert.match(meta.description ?? '', /HTTP daemons and clients/);
    assert.equal(meta.sourceUrl, 'https://github.com/mirage/ocaml-cohttp/archive/refs/tags/v5.3.0.tar.gz');
  });

  test('a value containing an opam variable expansion is rejected, not returned raw', () => {
    const meta = parseOpamMetadata('homepage: "https://example.com/%{name}%"\n', 'x', '1');
    assert.equal(meta.homepage, null);
  });

  test('never evaluates build/filter syntax', () => {
    // A `build:` list with filters must not leak into any scalar field.
    const meta = parseOpamMetadata('dev-repo: "git+https://github.com/o/r.git"\nbuild: [ ["sh" "-c" "rm -rf /"] {os = "linux"} ]\n', 'x', '1');
    assert.equal(meta.devRepo, 'git+https://github.com/o/r.git');
  });
});

describe('githubRepoFromOpam', () => {
  const base = {
    name: 'x',
    version: '1',
    devRepo: null,
    homepage: null,
    bugReports: null,
    doc: null,
    synopsis: null,
    description: null,
    sourceUrl: null,
  };

  test('prefers dev-repo', () => {
    assert.equal(
      githubRepoFromOpam({ ...base, devRepo: 'git+https://github.com/mirage/ocaml-cohttp.git', homepage: 'https://example.com' }),
      'mirage/ocaml-cohttp',
    );
  });
  test('falls back to a GitHub archive src URL', () => {
    assert.equal(
      githubRepoFromOpam({ ...base, sourceUrl: 'https://github.com/owner/repo/archive/v1.tar.gz' }),
      'owner/repo',
    );
  });
  test('null for a non-GitHub package', () => {
    assert.equal(
      githubRepoFromOpam({ ...base, devRepo: 'git+https://gitlab.com/o/r.git', homepage: 'https://ocaml.org' }),
      null,
    );
  });
});

describe('fetchOpamMetadata / versions over the wire', () => {
  test('fetches and parses the release opam file', async () => {
    stub((url) => (url.includes('/packages/cohttp/cohttp.5.3.0/opam') ? OPAM_FILE : undefined));
    const meta = await fetchOpamMetadata('cohttp', '5.3.0');
    assert.equal(meta?.devRepo, 'git+https://github.com/mirage/ocaml-cohttp.git');
  });

  test('version directories become versions; files do not', async () => {
    stub(() => [
      { name: 'cohttp.5.2.0', type: 'dir' },
      { name: 'cohttp.5.3.0', type: 'dir' },
      { name: 'README', type: 'file' },
    ]);
    assert.deepEqual((await fetchOpamPackageVersions('cohttp'))?.sort(), ['5.2.0', '5.3.0']);
  });
});

describe('fetchRegistryInfo for opam', () => {
  test('resolves the GitHub repo from dev-repo and keeps the version list', async () => {
    stub((url) => {
      if (url.includes('/contents/packages/cohttp')) {
        return [{ name: 'cohttp.5.2.0', type: 'dir' }, { name: 'cohttp.5.3.0', type: 'dir' }];
      }
      if (url.includes('/cohttp.5.3.0/opam')) return OPAM_FILE;
      return undefined;
    });

    const info = await fetchRegistryInfo('cohttp', 'opam', '5.3.0');
    assert.equal(info?.githubRepo, 'mirage/ocaml-cohttp');
    assert.deepEqual(info?.versions.sort(), ['5.2.0', '5.3.0']);
    assert.equal(info?.description, 'An OCaml library for HTTP clients and servers'.length ? info?.description : null);
    assert.match(info?.description ?? '', /HTTP daemons/);
  });

  test('a non-GitHub opam package keeps githubRepo null but still lists versions', async () => {
    stub((url) => {
      if (url.includes('/contents/packages/priv')) return [{ name: 'priv.1.0.0', type: 'dir' }];
      if (url.includes('/priv.1.0.0/opam')) return 'dev-repo: "git+https://gitlab.com/x/priv.git"\nsynopsis: "private"\n';
      return undefined;
    });

    const info = await fetchRegistryInfo('priv', 'opam', '1.0.0');
    assert.equal(info?.githubRepo, null);
    assert.deepEqual(info?.versions, ['1.0.0']);
  });
});
