import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parserFor } from '../../dist/detect/index.js';
import { directDependencies } from '../../dist/upgrade/scan.js';
import { lookupVersions } from '../../dist/upgrade/versions.js';
import { PACKAGE_MANAGERS } from '../../dist/detect/package-manager.js';
import { clearHttpCache } from '../../dist/util/http.js';

/**
 * Kubernetes' staging layout requires `k8s.io/api v0.0.0` and then redirects
 * it to `../api`. That `v0.0.0` is a placeholder for a module inside the
 * workspace, not an outdated release — but Drift sent it through ordinary
 * latest-version selection and proposed upgrading a directory to v0.37.0,
 * once per staging module, across a hundred rows.
 */

const KUBERNETES_STAGING = `module k8s.io/kubectl

go 1.24.0

require (
	github.com/spf13/cobra v1.10.1
	k8s.io/api v0.0.0
	k8s.io/apimachinery v0.0.0
	k8s.io/client-go v0.0.0
)

replace (
	k8s.io/api => ../api
	k8s.io/apimachinery => ../apimachinery
	k8s.io/client-go => ../client-go
)
`;

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  clearHttpCache();
});

describe('Go workspace-local replacements', () => {
  test('a module replaced by a directory records its resolution', () => {
    const parsed = parserFor('go.mod')!.parse(KUBERNETES_STAGING, 'staging/src/k8s.io/kubectl/go.mod');

    assert.deepEqual(parsed.get('k8s.io/api')?.resolution, { kind: 'local-replace', target: '../api' });
    assert.deepEqual(parsed.get('k8s.io/client-go')?.resolution, {
      kind: 'local-replace',
      target: '../client-go',
    });
    // An ordinary registry dependency is untouched.
    assert.equal(parsed.get('github.com/spf13/cobra')?.resolution, undefined);
    assert.equal(parsed.get('github.com/spf13/cobra')?.version, 'v1.10.1');
  });

  test('a replacement pointing at another published module is not local', () => {
    const parsed = parserFor('go.mod')!.parse(
      `module demo\n\nrequire golang.org/x/net v0.1.0\n\nreplace golang.org/x/net => github.com/fork/net v0.2.0\n`,
      'go.mod',
    );
    assert.equal(parsed.get('golang.org/x/net')?.resolution, undefined);
  });

  test('single-line replace directives are read too', () => {
    const parsed = parserFor('go.mod')!.parse(
      `module demo\n\nrequire k8s.io/api v0.0.0\n\nreplace k8s.io/api => ../api\n`,
      'go.mod',
    );
    assert.deepEqual(parsed.get('k8s.io/api')?.resolution, { kind: 'local-replace', target: '../api' });
  });

  test('a workspace-controlled module is never offered a registry upgrade', async () => {
    clearHttpCache();
    // The proxy would happily answer with v0.37.0; it must not be asked, and
    // its answer must not become an upgrade for a directory.
    let asked = false;
    globalThis.fetch = (() => {
      asked = true;
      return Promise.resolve(new Response('v0.37.0\n', { status: 200 }));
    }) as typeof fetch;

    const gomod = PACKAGE_MANAGERS.find((manager) => manager.id === 'go')!;
    const files = new Map([['/repo/go.mod', KUBERNETES_STAGING]]);
    const deps = await directDependencies(
      '/repo',
      { manager: gomod, dir: '', manifestPath: 'go.mod', lockfilePath: null },
      true,
      {
        readFile: async (path: string) => files.get(path) ?? null,
        readDirectory: async () => [],
        isDirectory: async () => false,
      },
    );

    const api = deps.find((dep) => dep.name === 'k8s.io/api');
    assert.deepEqual(api?.resolution, { kind: 'local-replace', target: '../api' });

    const lookup = await lookupVersions({
      name: api!.name,
      ecosystem: 'go',
      current: api!.current,
      range: api!.range,
      ...(api!.resolution ? { resolution: api!.resolution } : {}),
    });

    assert.equal(lookup.outcome, 'unchecked');
    if (lookup.outcome === 'unchecked') {
      assert.match(lookup.reason, /replaced by \.\.\/api in this workspace/);
      // Explicitly not "up to date": the question was not answered, it was
      // answered by the workspace.
      assert.doesNotMatch(lookup.reason, /up to date/i);
    }
    assert.equal(asked, false, 'the module proxy must not be consulted for a local replacement');
  });
});
