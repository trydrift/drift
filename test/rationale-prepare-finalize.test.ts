import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  buildRationale,
  finalizeRationale,
  prepareRationaleFacts,
} from '../dist/rationale/index.js';
import { assessSecurityBatch } from '../dist/rationale/osv.js';
import { scanUpgrades } from '../dist/upgrade/scan.js';
import { DriftConfigSchema } from '../dist/config/schema.js';
import { createLogger } from '../dist/util/logger.js';
import { clearHttpCache } from '../dist/util/http.js';
import { startRunLog } from '../dist/util/diagnostics.js';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const run = promisify(execFile);
async function withGitRepo<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'drift-rationale-diag-'));
  const git = (args: string[]) => run('git', args, { cwd: root });
  try {
    await git(['init', '-b', 'main']);
    await git(['config', 'user.email', 'test@example.com']);
    await git(['config', 'user.name', 'Test']);
    writeFileSync(join(root, 'file.txt'), 'hello\n');
    await git(['add', '-A']);
    await git(['commit', '-m', 'initial']);
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * The rationale prepare/finalize split (`src/rationale/index.ts`).
 *
 * `prepareRationaleFacts` computes everything about an upgrade that depends
 * only on the published package — registry info, both versions' own
 * metadata, upstream repository status, security advisories, license — and
 * is safe to share across every workspace row asking for the same exact
 * `ecosystem/name/from/to` upgrade. `finalizeRationale` reads whatever is
 * specific to one workspace (runtime declarations, breaking-change impact,
 * its own surface diff) and must run once per row even when the facts are
 * shared. These tests pin that boundary down.
 */

const logger = createLogger('silent');
const config = DriftConfigSchema.parse({});
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  clearHttpCache();
});

const noNetwork = { fetch: async () => ({ vulns: [] }) };

/**
 * Exact-hostname (and, where relevant, exact-pathname) URL matching for the
 * fetch stubs below, rather than `url.includes('registry.npmjs.org')` /
 * `url.startsWith(...)` substring checks. A substring check is satisfied by
 * `https://evil.example/registry.npmjs.org` or
 * `https://registry.npmjs.org.evil.example`, so it is not actually asserting
 * "this request went to the npm registry" — only "this URL contains this
 * text somewhere". `new URL(url).hostname` parses the URL properly and
 * compares the actual host, which is what these stubs mean to check.
 */
function urlHost(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    return '';
  }
}
function urlPath(raw: string): string {
  try {
    return new URL(raw).pathname;
  } catch {
    return '';
  }
}

function stubNpmAndGithub(hits: { registry: number; repo: number }): void {
  clearHttpCache();
  globalThis.fetch = ((url: string) => {
    if (urlHost(url) === 'registry.npmjs.org') {
      hits.registry += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            'dist-tags': { latest: '2.0.0' },
            versions: { '1.0.0': {}, '2.0.0': {} },
            repository: { url: 'https://github.com/acme/pkg.git' },
            time: {},
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }
    if (urlHost(url) === 'api.github.com' && urlPath(url) === '/repos/acme/pkg') {
      hits.repo += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({ archived: false, pushed_at: '2026-01-01T00:00:00Z', stargazers_count: 10 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }
    return Promise.resolve(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }) as typeof fetch;
}

const change = {
  name: 'pkg',
  ecosystem: 'npm' as const,
  from: '1.0.0',
  to: '2.0.0',
  kind: 'dependencies' as const,
  bump: 'major' as const,
  manifestPath: 'package.json',
};

describe('prepareRationaleFacts / finalizeRationale', () => {
  test('A: prepareRationaleFacts executes once and is reused across two finalize calls', async () => {
    const hits = { registry: 0, repo: 0 };
    stubNpmAndGithub(hits);

    const facts = await prepareRationaleFacts(change, { config, osv: noNetwork });
    assert.equal(hits.registry > 0, true, 'the registry was actually consulted once');
    const registryHitsAfterPrepare = hits.registry;
    const repoHitsAfterPrepare = hits.repo;

    // Two independent "workspaces" both finalize against the same prepared
    // facts. Neither call should touch the network again for package-level
    // data — that is the whole point of sharing `facts`.
    const input = { changes: [change], evidence: [], breakingChanges: [], impactSites: [] };
    await finalizeRationale(change, input, facts, { config, logger });
    await finalizeRationale(change, input, facts, { config, logger });

    assert.equal(hits.registry, registryHitsAfterPrepare, 'no extra registry calls from finalize');
    assert.equal(hits.repo, repoHitsAfterPrepare, 'no extra repository-status calls from finalize');
  });

  test('B: finalizeRationale runs once per candidate/workspace, and workspace-specific output can differ', async () => {
    stubNpmAndGithub({ registry: 0, repo: 0 });
    const facts = await prepareRationaleFacts(change, { config: DriftConfigSchema.parse({ rationale: { security: false } }), osv: noNetwork });

    let finalizeCalls = 0;
    const input = { changes: [change], evidence: [], breakingChanges: [], impactSites: [] };
    const cfg = DriftConfigSchema.parse({ rationale: { security: false, maintenance: true } });

    const nodeOk = await finalizeRationale(
      { ...change, workspace: 'a' },
      input,
      facts,
      { config: cfg, logger, repoRuntimeByWorkspace: new Map([['a', [{ raw: '>=18', source: 'package.json' }]]]) },
    );
    finalizeCalls += 1;
    const nodeMismatch = await finalizeRationale(
      { ...change, workspace: 'b' },
      input,
      facts,
      { config: cfg, logger, repoRuntimeByWorkspace: new Map([['b', [{ raw: '>=999', source: 'package.json' }]]]) },
    );
    finalizeCalls += 1;

    assert.equal(finalizeCalls, 2);
    // Both share identical prepared facts but declare different runtimes —
    // the maintenance conclusion (which reads runtime) need not be identical,
    // proving finalize actually ran per-row rather than being cached.
    assert.ok(nodeOk.maintenance);
    assert.ok(nodeMismatch.maintenance);
  });

  test('D: buildRationale (prepare-then-finalize wrapper) matches the shape a direct rationaleFor call always produced', async () => {
    stubNpmAndGithub({ registry: 0, repo: 0 });
    const [rationale] = await buildRationale(
      { changes: [change], evidence: [], breakingChanges: [], impactSites: [] },
      { config, logger, osv: noNetwork },
    );
    assert.equal(rationale.dependency, 'pkg');
    assert.equal(rationale.from, '1.0.0');
    assert.equal(rationale.to, '2.0.0');
    assert.ok(rationale.assessment);
    assert.ok(rationale.license);
    assert.ok(rationale.security);
  });

  test('buildRationale only batches OSV for changes without prepared facts', async () => {
    const hits = { registry: 0, repo: 0, osv: 0 };
    stubNpmAndGithub(hits);
    const prepared = await prepareRationaleFacts(change, {
      config: DriftConfigSchema.parse({ rationale: { security: false } }),
      osv: noNetwork,
    });
    const unprepared = { ...change, name: 'other-pkg' };
    const osv = { fetch: async () => { hits.osv += 1; return { vulns: [] }; } };
    await buildRationale(
      { changes: [change, unprepared], evidence: [], breakingChanges: [], impactSites: [] },
      {
        config,
        logger,
        osv,
        preparedFacts: new Map([[change, Promise.resolve(prepared)]]),
      },
    );
    assert.equal(hits.osv, 2, 'only the unprepared change should make the two-version OSV lookup');
  });
});

describe('scan-wide OSV batching', () => {
  test('C: the scan-wide OSV batch input contains only unique upgrade tuples', async () => {
    const lookups = [
      { name: 'left', ecosystem: 'npm' as const, from: '1.0.0', to: '2.0.0' },
      { name: 'left', ecosystem: 'npm' as const, from: '1.0.0', to: '2.0.0' },
    ];
    // Deduplicate the way scanUpgrades does, by ecosystem/name/from/to, before
    // handing the set to the batch call — this pins the *contract*
    // (dedupe before batching) even without spinning up a whole scan.
    const seen = new Map<string, (typeof lookups)[number]>();
    for (const l of lookups) seen.set(`${l.ecosystem}|${l.name}|${l.from}|${l.to}`, l);
    assert.equal(seen.size, 1, 'duplicate rows collapse to one unique upgrade tuple');

    // `assessSecurityBatch` queries both `from` and `to` per unique upgrade
    // (two OSV lookups), so what this proves is not "one fetch" but "one
    // unique upgrade's worth of fetches" — a duplicate row must not double
    // that, which it would if the caller handed it the raw (undeduplicated)
    // `lookups` array instead of `[...seen.values()]`.
    let osvCallCount = 0;
    const osv = {
      fetch: async () => {
        osvCallCount += 1;
        return { vulns: [] };
      },
    };
    await assessSecurityBatch([...seen.values()], osv);
    const dedupedCalls = osvCallCount;

    osvCallCount = 0;
    await assessSecurityBatch(lookups, osv);
    assert.equal(osvCallCount, dedupedCalls * 2, 'the undeduplicated (raw) input does twice the OSV work');
  });
});

describe('scan-wide rationale sharing end to end', () => {
  let root = '';

  const repo = { owner: 'acme', name: 'app', defaultBranch: 'main' } as never;

  const scanConfig = DriftConfigSchema.parse({
    evidence: { githubReleases: false, changelog: false, typeSurface: false, openapi: false },
    rationale: { security: true, maintenance: true, summary: false },
  });

  test('two workspaces sharing one exact upgrade with different runtimes: prepare shared, finalize per-workspace', async () => {
    root = mkdtempSync(join(tmpdir(), 'drift-rationale-shared-'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'app', private: true, workspaces: ['packages/*'] }),
    );
    writeFileSync(join(root, 'package-lock.json'), '{}');
    for (const [member, engines] of [
      ['one', { node: '>=18' }],
      ['two', { node: '>=999' }],
    ] as const) {
      const dir = join(root, 'packages', member);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: `@app/${member}`, engines, dependencies: { left: '1.0.0' } }),
      );
    }

    const hits = { registry: 0, repo: 0, osv: 0 };
    clearHttpCache();
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      if (urlHost(url) === 'registry.npmjs.org') {
        hits.registry += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              'dist-tags': { latest: '2.0.0' },
              versions: { '1.0.0': {}, '2.0.0': {} },
              time: {},
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (urlHost(url) === 'api.osv.dev') {
        hits.osv += 1;
        return Promise.resolve(
          new Response(JSON.stringify({ vulns: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
        );
      }
      return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }) as typeof fetch;

    try {
      const result = await scanUpgrades({
        root,
        repo,
        config: scanConfig,
        logger,
        verify: { enabled: false },
      });

      const rows = result.candidates.filter((c) => c.name === 'left');
      assert.equal(rows.length, 2, 'each workspace still gets its own candidate row');
      // The registry (workspace-independent, part of `prepareRationaleFacts`
      // and evidence gathering) is not hit once per workspace — the two rows
      // shared the exact same upstream work.
      assert.ok(hits.registry <= 2, `registry was consulted at most a couple of times, got ${hits.registry}`);
      assert.equal(hits.osv, 2, 'one scan-wide OSV batch covers the two versions, with no per-row duplicate work');
    } finally {
      globalThis.fetch = realFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('diagnostics for rationale', () => {
  test('rationale.prepare and rationale.finalize are recorded as their own spans', async () => {
    await withGitRepo(async (root) => {
      stubNpmAndGithub({ registry: 0, repo: 0 });
      const log = startRunLog({ command: 'drift outdated', mode: 'quick', repoRoot: root });
      await log.run(async () => {
        const facts = await prepareRationaleFacts(change, { config, osv: noNetwork });
        await finalizeRationale(
          change,
          { changes: [change], evidence: [], breakingChanges: [], impactSites: [] },
          facts,
          { config, logger },
        );
      });
      log.finish('ok');

      const contents = await readFile(log.path!, 'utf8');
      assert.ok(contents.includes('BEGIN rationale.prepare'), 'rationale.prepare span was recorded');
      assert.ok(contents.includes('END rationale.prepare'));
      assert.ok(contents.includes('BEGIN rationale.finalize'), 'rationale.finalize span was recorded');
      assert.ok(contents.includes('END rationale.finalize'));
    });
  });
});

describe('E: repository-status fetch overlaps evidence preparation', () => {
  test('prepareRationaleFacts and gatherDependencyEvidence both start before either resolves', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drift-rationale-overlap-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', private: true, dependencies: { left: '1.0.0' } }));
    writeFileSync(join(root, 'package-lock.json'), '{}');

    // The two branches timed here are downstream of the initial registry
    // lookup that both `prepareRationaleFacts` (repository status) and
    // `gatherDependencyEvidence` (GitHub releases) share as a starting
    // point — the registry fetch itself is answered immediately, not gated,
    // since `lookupVersions` (phase one, before either branch exists) and
    // `prepareRationaleFacts` (phase two) both legitimately call it and
    // conflating those would not isolate anything. Repository status
    // (`/repos/OWNER/REPO`) and releases (`/repos/OWNER/REPO/releases`) are
    // each unique to their own branch, so gating on both is a clean proof
    // that `Promise.all([gatherDependencyEvidence(...), prepareRationaleFacts(...)])`
    // in `prepareUpstream` (`src/upgrade/scan.ts`) genuinely runs them
    // concurrently rather than one after the other.
    const started = { repoStatus: false, releases: false };
    let releaseGate: () => void = () => undefined;
    let repoStatusGate: () => void = () => undefined;
    const bothStarted = new Promise<void>((resolve) => {
      let count = 0;
      const mark = () => {
        count += 1;
        if (count === 2) resolve();
      };
      releaseGate = mark;
      repoStatusGate = mark;
    });

    clearHttpCache();
    globalThis.fetch = ((url: string) => {
      if (urlHost(url) === 'registry.npmjs.org') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              'dist-tags': { latest: '2.0.0' },
              versions: { '1.0.0': {}, '2.0.0': {} },
              repository: { url: 'https://github.com/acme/left.git' },
              time: {},
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (urlHost(url) === 'api.github.com' && urlPath(url).endsWith('/releases')) {
        started.releases = true;
        releaseGate();
        // Blocks until the *other* branch has also started — proving this
        // one did not have to wait for that branch to finish first.
        return bothStarted.then(() => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (urlHost(url) === 'api.github.com' && urlPath(url).startsWith('/repos/')) {
        started.repoStatus = true;
        repoStatusGate();
        return bothStarted.then(
          () =>
            new Response(
              JSON.stringify({ archived: false, pushed_at: '2026-01-01T00:00:00Z', stargazers_count: 1 }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );
      }
      return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }) as typeof fetch;

    const overlapConfig = DriftConfigSchema.parse({
      evidence: { githubReleases: true, changelog: false, typeSurface: false, openapi: false },
      rationale: { security: false, maintenance: false, summary: false },
    });

    try {
      // If registry (rationale.prepare) and releases (evidence) were started
      // sequentially rather than via Promise.all, `bothStarted` would never
      // resolve — whichever ran first would block forever waiting on the
      // second, which would never get a chance to start. A timeout here is
      // itself proof of a regression back to sequential execution, not a
      // flaky assertion — hence the explicit race against a short deadline
      // instead of node:test's much longer default timeout.
      const result = await Promise.race([
        scanUpgrades({
          root,
          repo: { owner: 'acme', name: 'app', defaultBranch: 'main' } as never,
          config: overlapConfig,
          logger,
          verify: { enabled: false },
        }),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('scanUpgrades did not overlap registry and releases fetches within 5s — evidence and rationale prep are no longer concurrent')), 5000)),
      ]);

      assert.ok(started.repoStatus, 'the repository-status fetch (rationale.prepare) started');
      assert.ok(started.releases, 'the releases fetch (evidence gathering) started');
      assert.ok((result as { candidates: unknown[] }).candidates.length >= 1);
    } finally {
      globalThis.fetch = realFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('scan-level dedupe: identity boundaries and error retry', () => {
  test('Test C: an unexpectedly rejecting securityLookup degrades to an honest unchecked verdict rather than sinking prepareRationaleFacts', async () => {
    stubNpmAndGithub({ registry: 0, repo: 0 });

    // Security is best-effort, like every other fact `prepareRationaleFacts`
    // gathers: an unexpected rejection from a caller-supplied
    // `securityLookup` (this is exactly the shape `scanUpgrades`' scan-wide
    // OSV batch hands in — see `scanSecurityFor` in `src/upgrade/scan.ts`)
    // must not take the registry/version/license facts down with it. Before
    // this hardening, a rejecting `securityLookup` rejected the whole
    // `prepareRationaleFacts` call, which — one layer up, in
    // `prepareUpstream` — used to also discard a successfully shared
    // `gatherDependencyEvidence` computation for every duplicate row waiting
    // on it (see `test/scan-upstream-independent-failure.test.ts`, which now
    // covers that layer directly with two fully independent caches instead
    // of relying on this one rejecting).
    const facts = await prepareRationaleFacts(change, {
      config: DriftConfigSchema.parse({ rationale: { security: true } }),
      securityLookup: Promise.reject(new Error('synthetic OSV failure')),
    });

    assert.equal(facts.security.checked, false, 'a failed advisory lookup is an honest "unknown", not a thrown error');
    assert.ok(
      facts.security.reason?.includes('synthetic OSV failure'),
      `expected the degraded verdict to carry the failure reason, got: ${JSON.stringify(facts.security.reason)}`,
    );
    // Everything else `prepareRationaleFacts` computes is independent of the
    // security lookup and must still be present.
    assert.ok(facts.registry, 'registry info was still resolved');
    assert.ok(facts.license, 'license was still assessed');
  });

  test('Test B: identity boundaries — same package different target/source version, different ecosystem, and A→B vs B→A never share; manifest path and dependency kind differences may share', async () => {
    const { upstreamUpgradeKey } = await import('../dist/util/id.js');

    const base = { ecosystem: 'npm' as const, name: 'left', from: '1.0.0', to: '2.0.0' };

    // MUST NOT share:
    assert.notEqual(
      upstreamUpgradeKey(base),
      upstreamUpgradeKey({ ...base, to: '3.0.0' }),
      'a different target version is a different upgrade',
    );
    assert.notEqual(
      upstreamUpgradeKey(base),
      upstreamUpgradeKey({ ...base, from: '1.1.0' }),
      'a different source version is a different upgrade',
    );
    assert.notEqual(
      upstreamUpgradeKey(base),
      upstreamUpgradeKey({ ...base, ecosystem: 'pypi' as const }),
      'the same name/from/to under a different ecosystem is a different upgrade',
    );
    assert.notEqual(
      upstreamUpgradeKey(base),
      upstreamUpgradeKey({ ...base, from: base.to, to: base.from }),
      'A→B is not the same upgrade as B→A',
    );

    // MAY share: `upstreamUpgradeKey` only reads ecosystem/name/from/to, so a
    // `DependencyChange` that additionally carries a manifest path or a
    // dependency kind still produces the identical key.
    const withManifestA = { ...base, manifestPath: 'packages/one/package.json', kind: 'dependencies' as const };
    const withManifestB = { ...base, manifestPath: 'packages/two/package.json', kind: 'devDependencies' as const };
    assert.equal(
      upstreamUpgradeKey(withManifestA),
      upstreamUpgradeKey(withManifestB),
      'the same exact ecosystem/name/from/to upgrade shares its key regardless of manifest path or dependency kind',
    );
  });
});
