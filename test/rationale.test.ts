import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessLicense,
  assessMaintenance,
  assessSecurity,
  assessSecurityBatch,
  assessUpgrade,
  bulletLines,
  buildRationale,
  classify,
  cvssBaseScore,
  describeAge,
  isAllowed,
  mergeAliases,
  raisesMinimum,
  summarizeRelease,
} from '../dist/rationale/index.js';
import { renderOne } from '../dist/report/rationale.js';
import { summarize as summarizeCandidate } from '../dist/upgrade/summary.js';
import { DriftConfigSchema } from '../dist/config/schema.js';
import { createLogger } from '../dist/util/logger.js';
import { clearHttpCache } from '../dist/util/http.js';

/**
 * The upgrade rationale.
 *
 * The rule under test throughout is the one the feature exists to keep: a claim
 * Drift cannot cite is a claim Drift does not make. So the assertions here are
 * mostly about restraint — that an unreachable source degrades the conclusion
 * rather than being read as an all-clear, that a benefit is never inferred from
 * a version number, and that the same failure is never stated twice.
 */

const logger = createLogger('silent');
const config = DriftConfigSchema.parse({});

const NOW = new Date('2026-08-01T00:00:00Z');

describe('OSV severity and fix resolution', () => {
  test('scores CVSS v3 vectors to the published formula', () => {
    assert.equal(cvssBaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'), 9.8);
    assert.equal(cvssBaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N'), 6.1);
    assert.equal(cvssBaseScore('CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:U/C:N/I:N/A:L'), 1.8);
  });

  test('an unparseable vector is unknown, never a default score', () => {
    assert.equal(cvssBaseScore('CVSS:2.0/AV:N'), null);
    assert.equal(cvssBaseScore('nonsense'), null);
  });

  test('one advisory carried by three databases is one finding', () => {
    const merged = mergeAliases([
      { id: 'GO-2024-2687', aliases: ['CVE-2023-45288'], summary: 'HTTP/2 flood', severity: 'unknown', url: 'a', fixedIn: '0.23.0' },
      { id: 'GHSA-4v7x-pqxf-cx7m', aliases: ['CVE-2023-45288', 'GO-2024-2687'], summary: 'HTTP/2 flood', severity: 'medium', url: 'b', fixedIn: '0.23.0' },
    ]);

    assert.equal(merged.length, 1);
    // The record that states a severity leads; the others become its aliases.
    assert.equal(merged[0]!.id, 'GHSA-4v7x-pqxf-cx7m');
    assert.equal(merged[0]!.severity, 'medium');
    assert.deepEqual(merged[0]!.aliases, ['CVE-2023-45288', 'GO-2024-2687']);
  });

  test('unrelated advisories are not merged', () => {
    const merged = mergeAliases([
      { id: 'GHSA-a', aliases: ['CVE-1'], summary: 'x', severity: 'high', url: 'a', fixedIn: null },
      { id: 'GHSA-b', aliases: ['CVE-2'], summary: 'y', severity: 'low', url: 'b', fixedIn: null },
    ]);
    assert.equal(merged.length, 2);
  });
});

describe('security assessment', () => {
  const osvResponse = (vulns: Record<string, unknown>[]) => ({ vulns });

  const fakeOsv = (byVersion: Record<string, Record<string, unknown>[]>) => ({
    fetch: async (_url: string, body: unknown) => {
      const version = (body as { version: string }).version;
      return osvResponse(byVersion[version] ?? []);
    },
  });

  const vuln = (id: string, fixed: string, over: Record<string, unknown> = {}) => ({
    id,
    summary: `${id} summary.`,
    database_specific: { severity: 'HIGH' },
    affected: [{ ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed }] }] }],
    references: [{ type: 'ADVISORY', url: `https://example.test/${id}` }],
    ...over,
  });

  test('reports what the upgrade resolves, carries, and introduces', async () => {
    const result = await assessSecurity('pkg', 'npm', '1.0.0', '2.0.0', fakeOsv({
      '1.0.0': [vuln('GHSA-fixed', '2.0.0'), vuln('GHSA-both', '9.0.0')],
      '2.0.0': [vuln('GHSA-both', '9.0.0'), vuln('GHSA-new', '3.0.0')],
    }));

    assert.equal(result.checked, true);
    assert.deepEqual(result.resolved.map((v) => v.id), ['GHSA-fixed']);
    assert.deepEqual(result.carried.map((v) => v.id), ['GHSA-both']);
    assert.deepEqual(result.introduced.map((v) => v.id), ['GHSA-new']);
    assert.equal(result.direction, 'mixed');
  });

  test('the same advisory under a different primary id is not both resolved and introduced', async () => {
    const result = await assessSecurity('pkg', 'go', '1.0.0', '2.0.0', fakeOsv({
      '1.0.0': [vuln('GO-2024-1', '9.0.0', { aliases: ['CVE-2024-1'] })],
      '2.0.0': [vuln('GHSA-xyz', '9.0.0', { aliases: ['CVE-2024-1', 'GO-2024-1'] })],
    }));

    assert.deepEqual(result.resolved, []);
    assert.deepEqual(result.introduced, []);
    assert.equal(result.carried.length, 1);
    assert.equal(result.direction, 'preserves');
  });

  test('an unreachable OSV is unchecked, never an all-clear', async () => {
    const result = await assessSecurity('pkg', 'npm', '1.0.0', '2.0.0', {
      fetch: async () => null,
    });

    assert.equal(result.checked, false);
    assert.equal(result.direction, 'unknown');
    assert.deepEqual(result.current, []);
  });

  test('an empty answer is no advisories, not a failed lookup', async () => {
    // What OSV actually returns for a package with a clean record: HTTP 200
    // and `{}`. Reading that as unreachable turned every clean package into
    // "effect on known vulnerabilities is unknown".
    const result = await assessSecurity('pkg', 'npm', '1.0.0', '2.0.0', { fetch: async () => ({}) });

    assert.equal(result.checked, true, 'a 200 with no vulns is an answer');
    assert.equal(result.direction, 'preserves');
    assert.deepEqual(result.current, []);
  });

  test('a failed lookup carries why, so a timeout is not reported as a firewall', async () => {
    const result = await assessSecurity('pkg', 'npm', '1.0.0', '2.0.0', {
      fetch: async () => ({ osvFailure: 'OSV rate-limited this scan (HTTP 429)' }),
    });

    assert.equal(result.checked, false);
    assert.match(result.reason ?? '', /429/);
  });

  test('batch lookup preserves query order across multiple upgrades', async () => {
    const first = { name: 'pkg', ecosystem: 'npm' as const, from: '1.0.0', to: '2.0.0' };
    const second = { name: 'lib', ecosystem: 'pypi' as const, from: '3.0.0', to: '4.0.0' };
    const calls: unknown[][] = [];

    const result = await assessSecurityBatch([first, second], {
      batchFetch: async (queries) => {
        calls.push([...queries]);
        return [
          osvResponse([vuln('GHSA-fixed', '2.0.0')]),
          osvResponse([]),
          osvResponse([]),
          osvResponse([vuln('GHSA-new', '9.0.0')]),
        ];
      },
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0]!.map((query) => (query as { package: { name: string }; version: string }).package.name),
      ['pkg', 'pkg', 'lib', 'lib'],
    );
    assert.deepEqual(result.get(first)!.resolved.map((v) => v.id), ['GHSA-fixed']);
    assert.deepEqual(result.get(second)!.introduced.map((v) => v.id), ['GHSA-new']);
  });

  test('an ecosystem OSV has no coverage for says so, rather than blaming the network', async () => {
    let called = false;
    const result = await assessSecurity('x', 'cocoapods', '1', '2', {
      fetch: async () => {
        called = true;
        return null;
      },
    });

    assert.equal(called, false, 'nothing is queried, so nothing can have failed');
    assert.equal(result.checked, false);
    assert.match(result.reason ?? '', /no advisory coverage for cocoapods/);
  });

  test('an ecosystem OSV does not index is not queried', async () => {
    let called = false;
    await assessSecurity('x', 'maven', '1', '2', {
      fetch: async () => {
        called = true;
        return null;
      },
    });
    // Maven *is* indexed, so this asserts the opposite direction: it is queried.
    assert.equal(called, true);
  });

  test('a withdrawn advisory is not reported', async () => {
    const result = await assessSecurity('pkg', 'npm', '1.0.0', '2.0.0', fakeOsv({
      '1.0.0': [vuln('GHSA-gone', '2.0.0', { withdrawn: '2026-01-01T00:00:00Z' })],
      '2.0.0': [],
    }));
    assert.deepEqual(result.current, []);
  });
});

describe('maintenance facts', () => {
  const base = {
    name: 'pkg',
    ecosystem: 'npm' as const,
    from: '1.0.0',
    to: '2.0.0',
    registry: null,
    repository: null,
    currentVersion: null,
    targetVersion: null,
    now: NOW,
  };

  test('an archived repository is concerning; a quiet one is merely stated', () => {
    const archived = assessMaintenance({
      ...base,
      repository: { archived: true, pushedAt: null, license: null, url: 'https://example.test' },
    });
    assert.equal(archived.archived, true);
    assert.ok(archived.facts.some((f) => f.concerning && /archived/.test(f.statement)));

    const quiet = assessMaintenance({
      ...base,
      repository: { archived: false, pushedAt: '2023-01-01T00:00:00Z', license: null, url: 'https://example.test' },
    });
    // Stated with a date and no judgement: a finished library is not a failing one.
    assert.ok(quiet.facts.some((f) => /last pushed/.test(f.statement)));
    assert.equal(quiet.facts.every((f) => !f.concerning), true);
  });

  test('a withdrawn target version is concerning and quotes the reason', () => {
    const result = assessMaintenance({
      ...base,
      targetVersion: {
        version: '2.0.0',
        license: null,
        releasedAt: null,
        runtime: null,
        dependencies: [],
        withdrawn: 'Retracted by the maintainer: published in error.',
      },
    });
    assert.equal(result.deprecated, 'Retracted by the maintainer: published in error.');
    assert.ok(result.facts[0]!.concerning);
    assert.match(result.facts[0]!.statement, /published in error/);
  });

  test('a changed runtime minimum is stated as context, not judged by maintenance (#110)', () => {
    const version = (requirement: string) => ({
      version: 'v',
      license: null,
      releasedAt: null,
      runtime: { name: 'Node.js', requirement },
      dependencies: [],
      withdrawn: null,
    });

    // Both directions produce the same plain, non-blocking context fact.
    // Whether the change matters to this repository is the canonical
    // RuntimeRequirementAnalysis's call now, not maintenance's.
    for (const [from, to] of [['>=14', '>=18'], ['>=18', '>=14']] as const) {
      const result = assessMaintenance({ ...base, currentVersion: version(from), targetVersion: version(to) });
      const fact = result.facts.find((f) => /Node\.js version changed/.test(f.statement));
      assert.ok(fact, `${from} -> ${to}`);
      assert.equal(fact!.concerning, false);
      assert.equal(fact!.polarity, 'context');
    }
  });

  test('raisesMinimum reads the floor out of a requirement string', () => {
    assert.equal(raisesMinimum('>=14', '>=18'), true);
    assert.equal(raisesMinimum('>=1.17', '>=1.23.0'), true);
    assert.equal(raisesMinimum('>=18', '>=18'), false);
    assert.equal(raisesMinimum('>=18', '>=16'), false);
  });

  test('being behind the latest release is stated as arithmetic, not as neglect', () => {
    const result = assessMaintenance({
      ...base,
      from: '1.0.0',
      to: '2.0.0',
      registry: {
        name: 'pkg',
        ecosystem: 'npm',
        githubRepo: null,
        homepage: null,
        versions: ['1.0.0', '2.0.0', '4.1.0'],
        deprecated: null,
        description: null,
      },
    });

    assert.equal(result.latestStable, '4.1.0');
    assert.ok(result.facts.some((f) => /not the latest release; 4\.1\.0/.test(f.statement)));
    assert.ok(result.facts.some((f) => /3 major versions behind/.test(f.statement)));
  });

  test('release ages read the way a person would say them', () => {
    assert.equal(describeAge('2026-08-01T00:00:00Z', NOW), 'today');
    assert.equal(describeAge('2026-07-14T00:00:00Z', NOW), '18 days ago');
    assert.equal(describeAge('2026-02-01T00:00:00Z', NOW), 'about 6 months ago');
    assert.equal(describeAge('2021-08-01T00:00:00Z', NOW), 'about 5 years ago');
  });
});

describe('license policy', () => {
  const policy = (over: Record<string, unknown> = {}) =>
    DriftConfigSchema.parse({ licenses: { enabled: true, ...over } }).licenses;

  test('a denylist entry always beats an allowlist', () => {
    const p = policy({ allow: ['MIT', 'AGPL-3.0'], deny: ['AGPL-3.0'] });
    assert.equal(isAllowed('MIT', p), true);
    assert.equal(isAllowed('AGPL-3.0', p), false);
  });

  test('a dual license is satisfied by either branch, because the consumer chooses', () => {
    const p = policy({ allow: ['MIT', 'Apache-2.0'] });
    assert.equal(isAllowed('MIT OR Apache-2.0', p), true);
    assert.equal(isAllowed('AGPL-3.0 OR Commercial', p), false);
    // A conjunction binds the consumer to both, so both must be permitted.
    assert.equal(isAllowed('MIT AND AGPL-3.0', p), false);
  });

  test('an unreadable license is permitted unless the policy asks otherwise', () => {
    assert.equal(isAllowed(null, policy({ allow: ['MIT'] })), true);
    assert.equal(isAllowed(null, policy({ allow: ['MIT'], requireDeclared: true })), false);
  });

  test('with the policy off, nothing is a violation', () => {
    const off = DriftConfigSchema.parse({}).licenses;
    assert.equal(isAllowed('AGPL-3.0', off), true);
  });

  test('a change from MIT to AGPL is reported, and named as a policy conflict', async () => {
    const version = (license: string) => ({
      version: 'v',
      license,
      releasedAt: null,
      runtime: null,
      dependencies: [],
      withdrawn: null,
    });

    const finding = await assessLicense({
      name: 'pkg',
      ecosystem: 'npm',
      from: '1.0.0',
      to: '2.0.0',
      currentVersion: version('MIT'),
      targetVersion: version('AGPL-3.0'),
      repository: null,
      policy: policy({ allow: ['MIT', 'BSD-3-Clause', 'Apache-2.0'] }),
    });

    assert.equal(finding.verdict, 'policy-violation');
    assert.equal(finding.from, 'MIT');
    assert.equal(finding.to, 'AGPL-3.0');
    assert.match(finding.statement, /changed from MIT to AGPL-3\.0/);
    assert.match(finding.statement, /MIT, BSD-3-Clause, Apache-2\.0/);
  });

  test('an unchanged permitted license is silent', async () => {
    const version = { version: 'v', license: 'MIT', releasedAt: null, runtime: null, dependencies: [], withdrawn: null };
    const finding = await assessLicense({
      name: 'pkg',
      ecosystem: 'npm',
      from: '1.0.0',
      to: '2.0.0',
      currentVersion: version,
      targetVersion: version,
      repository: null,
      policy: policy({ allow: ['MIT'] }),
    });
    assert.equal(finding.verdict, 'ok');
  });

  test('with no policy configured, missing metadata is not reported as a gap', async () => {
    const finding = await assessLicense({
      name: 'golang.org/x/net',
      ecosystem: 'go',
      from: 'v1',
      to: 'v2',
      currentVersion: null,
      targetVersion: null,
      repository: null,
      policy: DriftConfigSchema.parse({}).licenses,
    });
    assert.equal(finding.verdict, 'ok');
  });

  test('requireDeclared turns a missing license into a violation, not an unknown', async () => {
    const finding = await assessLicense({
      name: 'pkg',
      ecosystem: 'go',
      from: 'v1',
      to: 'v2',
      currentVersion: null,
      targetVersion: null,
      repository: null,
      policy: policy({ allow: ['MIT'], requireDeclared: true }),
    });
    assert.equal(finding.verdict, 'policy-violation');
    assert.match(finding.statement, /declares a license Drift could read/);
  });

  describe('introduced-dependency violations survive the early returns', () => {
    const realFetch = globalThis.fetch;
    const npmPackument = (license: string) => ({
      versions: { latest: { license } },
      time: {},
    });

    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    test('an allowed license change does not hide a denied introduced dependency', async () => {
      globalThis.fetch = (() =>
        Promise.resolve(new Response(JSON.stringify(npmPackument('AGPL-3.0'))))) as typeof fetch;

      const version = (license: string, dependencies: string[] = []) => ({
        version: 'v',
        license,
        releasedAt: null,
        runtime: null,
        dependencies,
        withdrawn: null,
      });

      const finding = await assessLicense({
        name: 'pkg',
        ecosystem: 'npm',
        from: '1.0.0',
        to: '2.0.0',
        currentVersion: version('MIT'),
        targetVersion: version('BSD-3-Clause', ['bad-dep']),
        repository: null,
        policy: policy({ allow: ['MIT', 'BSD-3-Clause'], deny: ['AGPL-3.0'] }),
      });

      // Both versions are on the allowlist, so absent the introduced-dependency
      // check this would be 'changed'. The regression was the early return in
      // the license-change branch skipping `violating` entirely.
      assert.equal(finding.verdict, 'policy-violation');
      assert.match(finding.statement, /bad-dep/);
    });

    test('a missing own license does not hide a denied introduced dependency', async () => {
      globalThis.fetch = (() =>
        Promise.resolve(new Response(JSON.stringify(npmPackument('AGPL-3.0'))))) as typeof fetch;

      const finding = await assessLicense({
        name: 'pkg',
        ecosystem: 'npm',
        from: '1.0.0',
        to: '2.0.0',
        currentVersion: { version: 'v', license: 'MIT', releasedAt: null, runtime: null, dependencies: [], withdrawn: null },
        targetVersion: {
          version: 'v2',
          license: null,
          releasedAt: null,
          runtime: null,
          dependencies: ['bad-dep'],
          withdrawn: null,
        },
        repository: null,
        policy: policy({ allow: ['MIT'], deny: ['AGPL-3.0'] }),
      });

      // Own license going missing (MIT -> unreadable) would independently earn
      // 'unknown'; the regression under test is that the denied introduced
      // dependency must not be lost regardless, so the verdict escalates to a
      // policy violation rather than settling for 'unknown'.
      assert.equal(finding.verdict, 'policy-violation');
      assert.match(finding.statement, /bad-dep/);
    });
  });
});

describe('release summaries', () => {
  test('classification takes the maintainer at their word, and never promotes', () => {
    assert.equal(classify('BREAKING: `foo` was removed'), 'breaking');
    assert.equal(classify('Fixes CVE-2026-1234 in request parsing'), 'security');
    assert.equal(classify('Reduces allocation during response decoding'), 'performance');
    assert.equal(classify('Fix a crash when the socket closes early'), 'fix');
    // Nothing in this line claims anything, so it gets the weakest label.
    assert.equal(classify('Update the documentation for the client'), 'improvement');
  });

  test('security wins over breaking when a line is both', () => {
    assert.equal(classify('BREAKING: removed the vulnerable `exec` helper (CVE-2026-1)'), 'security');
  });

  test('headings and credits are not changes', () => {
    const lines = bulletLines(
      ['## Breaking changes', '', '- `Client.Do` now requires a context argument', 'by @someone', '---', '- Fix a leak in the pool'].join('\n'),
    );
    assert.deepEqual(lines, ['`Client.Do` now requires a context argument', 'Fix a leak in the pool']);
  });

  test('nested removal lists keep the parent context', () => {
    const lines = bulletLines(
      [
        'The following have been removed entirely:',
        '',
        '- The following polyfills: Array.forEach, performance.now and requestAnimationFrame.',
      ].join('\n'),
    );

    assert.deepEqual(lines, [
      'The following have been removed entirely: The following polyfills: Array.forEach, performance.now and requestAnimationFrame.',
    ]);
    assert.equal(classify(lines[0]!), 'breaking');
  });

  test('a dotted API name is not a performance claim by itself', () => {
    assert.equal(classify('The following polyfills: performance.now and requestAnimationFrame.'), 'improvement');
    assert.equal(classify('Improve performance during response decoding'), 'performance');
  });

  test('a computed breaking change carries its impact count', () => {
    const summary = summarizeRelease({
      dependency: 'pkg',
      evidence: [],
      breakingChanges: [
        {
          id: 'bc1',
          dependency: 'pkg',
          kind: 'signature-change',
          summary: 'The signature of `Client.Do` changed.',
          remediation: 'x',
          symbols: ['Client.Do'],
          confidence: 'high',
          citations: [],
        },
      ],
      impactSites: [
        { breakingChangeId: 'bc1', file: 'a.go', line: 1, excerpt: '', matchedSymbol: 'Client.Do', confidence: 'high' },
        { breakingChangeId: 'bc1', file: 'b.go', line: 2, excerpt: '', matchedSymbol: 'Client.Do', confidence: 'high' },
      ],
    });

    assert.equal(summary.changes[0]!.category, 'breaking');
    assert.equal(summary.changes[0]!.affectedSites, 2);
  });

  test('prose restating a computed finding is not listed twice', () => {
    const summary = summarizeRelease({
      dependency: 'pkg',
      evidence: [
        {
          id: 'ev1',
          source: 'github-release',
          dependency: 'pkg',
          title: 't',
          content: '- `Client.Do` now requires a context argument',
          weight: 0.7,
          url: 'https://example.test/r',
        },
      ],
      breakingChanges: [
        {
          id: 'bc1',
          dependency: 'pkg',
          kind: 'signature-change',
          summary: 'The signature of `Client.Do` changed.',
          remediation: 'x',
          symbols: ['Client.Do'],
          confidence: 'high',
          citations: ['ev1'],
        },
      ],
      impactSites: [],
    });

    assert.equal(summary.changes.filter((c) => /Client\.Do/.test(c.text)).length, 1);
  });

  test('every prose line keeps the record it came from', () => {
    const summary = summarizeRelease({
      dependency: 'pkg',
      evidence: [
        {
          id: 'ev1',
          source: 'changelog',
          dependency: 'pkg',
          title: 't',
          content: '- Reduces allocation during response decoding',
          weight: 0.65,
          url: 'https://example.test/c',
        },
      ],
      breakingChanges: [],
      impactSites: [],
    });

    assert.equal(summary.changes[0]!.citation, 'ev1');
    assert.equal(summary.changes[0]!.url, 'https://example.test/c');
  });
});

describe('the upgrade assessment', () => {
  const clean = {
    checked: true,
    current: [],
    target: [],
    resolved: [],
    introduced: [],
    carried: [],
    direction: 'preserves' as const,
  };

  const input = (over: Record<string, unknown> = {}) =>
    ({
      dependency: 'pkg',
      breakingChanges: [],
      impactSites: [],
      evidence: [],
      security: clean,
      maintenance: { facts: [] },
      license: { verdict: 'ok' as const, statement: '', introduced: [] },
      gaps: [],
      surfaceCompared: true,
      ...over,
    }) as never;

  const vuln = (id: string, severity: string) => ({
    id,
    aliases: [],
    summary: 's',
    severity,
    url: 'u',
    fixedIn: null,
  });

  test('a clean, compared upgrade is safe to take', () => {
    assert.equal(assessUpgrade(input()).recommendation, 'safe-to-upgrade');
  });

  test('a role-specific package contract change requires review without pretending it is a code API', () => {
    const breakingChanges = [{
        id: 'bc-pom', dependency: 'parent', kind: 'signature-change', summary: 'parent changed',
        remediation: 'review the POM', symbols: ['pom:parent', 'org.example:base'], confidence: 'high', citations: [],
      }];
    const result = assessUpgrade(input({ breakingChanges }));
    assert.equal(result.recommendation, 'upgrade-after-review');
    assert.match(result.reasons.join(' '), /published Maven POM contract change/);
    assert.doesNotMatch(result.reasons.join(' '), /\bAPI\b|none of which this repository uses/);
    assert.match(result.confidenceBasis, /computed Maven POM contract diff/);
    const summary = summarizeCandidate(1, breakingChanges as never, [], 'parent', {
      assessment: result,
      security: clean,
      gaps: [],
    } as never);
    assert.match(summary, /published Maven POM contract change requires review/);
    assert.doesNotMatch(summary, /\bAPI\b|none of which this repository uses/);
  });

  test('an unlocalized upstream finding cannot be called safe when indexing was truncated', () => {
    const finding = {
      id: 'bc1', dependency: 'pkg', kind: 'removed-export', summary: 'removed',
      remediation: 'review', symbols: ['old'], confidence: 'high', citations: [],
    };
    assert.equal(
      assessUpgrade(input({
        breakingChanges: [finding],
        localizationRan: true,
        localizationComplete: false,
      })).recommendation,
      'upgrade-after-review',
    );
  });

  test('resolving a vulnerability makes it recommended', () => {
    const result = assessUpgrade(
      input({ security: { ...clean, resolved: [vuln('GHSA-1', 'high')], direction: 'improves' } }),
    );
    assert.equal(result.recommendation, 'upgrade-recommended');
    assert.ok(result.reasons.some((r: string) => /Fixes 1 known vulnerability \(worst: high\)/.test(r)));
  });

  test('introducing a vulnerability outranks everything else', () => {
    const result = assessUpgrade(
      input({
        security: {
          ...clean,
          resolved: [vuln('GHSA-1', 'high')],
          introduced: [vuln('GHSA-2', 'critical')],
          direction: 'mixed',
        },
      }),
    );
    assert.equal(result.recommendation, 'do-not-upgrade-yet');
  });

  test('a withdrawn target version is never recommended', () => {
    const result = assessUpgrade(input({ maintenance: { facts: [], deprecated: 'yanked' } }));
    assert.equal(result.recommendation, 'do-not-upgrade-yet');
  });

  test('a policy violation stops the upgrade', () => {
    const result = assessUpgrade(
      input({ license: { verdict: 'policy-violation', statement: 'AGPL now', introduced: [] } }),
    );
    assert.equal(result.recommendation, 'do-not-upgrade-yet');
  });

  test('a maintenance fact that blocks the upgrade is never safe-to-upgrade or upgrade-recommended', () => {
    // e.g. this repository's declared runtime does not satisfy the target's
    // raised floor. `concerning: true` alone must not be read as "recommend
    // it" -- only `polarity: 'blocks'` may veto, and it must veto hard.
    const result = assessUpgrade(
      input({
        maintenance: {
          facts: [
            {
              statement: 'The required Node.js version changed from >=18 to >=22. This repository does not satisfy it: .nvmrc (declares 18.18.0).',
              concerning: true,
              polarity: 'blocks',
            },
          ],
        },
      }),
    );
    assert.notEqual(result.recommendation, 'safe-to-upgrade');
    assert.notEqual(result.recommendation, 'upgrade-recommended');
    assert.equal(result.recommendation, 'do-not-upgrade-yet');
  });

  test('a partially-compatible declared runtime also blocks, not just outright incompatibility', () => {
    const result = assessUpgrade(
      input({
        maintenance: {
          facts: [
            {
              statement: "This repository's declared range is only partially compatible: package.json (declares >=18) allows versions the new floor rejects.",
              concerning: true,
              polarity: 'blocks',
            },
          ],
        },
      }),
    );
    assert.notEqual(result.recommendation, 'safe-to-upgrade');
    assert.notEqual(result.recommendation, 'upgrade-recommended');
  });

  test('a runtime fact confirming this repository already satisfies the new floor does not block the upgrade', () => {
    const result = assessUpgrade(
      input({
        maintenance: {
          facts: [
            {
              statement: 'The required Node.js version changed from >=18 to >=22. This repository already satisfies it (package.json).',
              concerning: false,
              polarity: 'context',
            },
          ],
        },
      }),
    );
    assert.equal(result.recommendation, 'safe-to-upgrade');
  });

  test('a genuinely positive maintenance fact (installed version withdrawn) can still recommend the upgrade', () => {
    const result = assessUpgrade(
      input({
        maintenance: {
          facts: [
            {
              statement: 'The version currently installed, 1.0.0, has been withdrawn: security issue.',
              concerning: true,
              polarity: 'favors',
            },
          ],
        },
      }),
    );
    assert.equal(result.recommendation, 'upgrade-recommended');
  });

  test('an unverified "check by hand" runtime fact is merely context: it neither blocks nor recommends', () => {
    const result = assessUpgrade(
      input({
        maintenance: {
          facts: [
            {
              statement: 'The required Node.js version changed from >=18 to >=22. Check this against the runtimes this repository builds and deploys on.',
              concerning: true,
              polarity: 'context',
            },
          ],
        },
      }),
    );
    assert.equal(result.recommendation, 'safe-to-upgrade');
  });

  test('a benign license change is silent in reasons too, not just the rendered section', () => {
    // renderLicense() suppresses 'changed' from the License section. If
    // assessUpgrade still pushed the statement into `reasons`, it would
    // resurface under "Why Drift concluded this" — the suppression would be
    // cosmetic only.
    const result = assessUpgrade(
      input({
        license: {
          verdict: 'changed',
          statement: 'The declared license changed from MIT to BSD-3-Clause.',
          introduced: [],
        },
      }),
    );
    assert.equal(result.reasons.some((r: string) => /declared license changed/.test(r)), false);
  });

  test('mechanical impact needs review; a behaviour change needs a person', () => {
    const site = { breakingChangeId: 'bc1', file: 'a.ts', line: 1, excerpt: '', matchedSymbol: 'x', confidence: 'high' };
    const change = (kind: string) => ({
      id: 'bc1',
      dependency: 'pkg',
      kind,
      summary: 's',
      remediation: 'r',
      symbols: ['x'],
      confidence: 'high',
      citations: [],
    });

    assert.equal(
      assessUpgrade(input({ breakingChanges: [change('renamed-export')], impactSites: [site] })).recommendation,
      'upgrade-after-review',
    );
    assert.equal(
      assessUpgrade(input({ breakingChanges: [change('behaviour-change')], impactSites: [site] })).recommendation,
      'manual-migration-required',
    );
  });

  test('nothing readable is insufficient evidence, not a clean bill of health', () => {
    const result = assessUpgrade(
      input({
        surfaceCompared: false,
        security: { ...clean, checked: false, direction: 'unknown' },
        gaps: ['Nothing was reachable.'],
      }),
    );
    assert.equal(result.recommendation, 'insufficient-evidence');
    assert.equal(result.confidence, 'low');
  });

  test('a source that answered "nothing found" still counts as having looked', () => {
    const result = assessUpgrade(input({ surfaceCompared: true, gaps: ['No changelog was reachable.'] }));
    assert.equal(result.recommendation, 'safe-to-upgrade');
  });

  test('a changelog that announced nothing was still read', () => {
    // The document produced no evidence record precisely because it flagged
    // nothing. Counting records rather than documents is what filed seven
    // Arduino libraries as "not verified" with their release notes in cache.
    const result = assessUpgrade(
      input({
        surfaceCompared: false,
        security: { ...clean, checked: false, direction: 'unknown' },
        evidence: [],
        proseRead: 4,
        gaps: ['Drift read 4 sets of release notes and found nothing that announces a breaking change.'],
      }),
    );

    assert.equal(result.recommendation, 'safe-to-upgrade');
    assert.match(result.confidenceBasis, /[Rr]elease notes/);
  });

  test('release notes that were read are an answer, not an absence', () => {
    // The header diff could not run and OSV was unreachable, but four sets of
    // release notes were fetched and read. "Not verified" would put this beside
    // the packages where nothing at all could be had, which it is not.
    const result = assessUpgrade(
      input({
        surfaceCompared: false,
        security: { ...clean, checked: false, direction: 'unknown' },
        evidence: [
          { id: 'e1', source: 'github-release', dependency: 'pkg', title: 't', content: 'c', weight: 0.7 },
        ],
        gaps: ['Drift read the release notes and found nothing that announces a breaking change.'],
      }),
    );

    assert.equal(result.recommendation, 'safe-to-upgrade');
    assert.equal(result.confidence, 'medium', 'prose alone never reads as strongly as a diff');
    assert.ok(result.reasons.some((r: string) => /Drift read the release notes/.test(r)));
  });

  test('confidence names what it rests on', () => {
    const withProse = assessUpgrade(
      input({
        evidence: [
          { id: 'e1', source: 'github-release', dependency: 'pkg', title: 't', content: 'c', weight: 0.7 },
        ],
      }),
    );
    assert.equal(withProse.confidence, 'high');
    assert.match(withProse.confidenceBasis, /computed API diff.*release notes.*OSV/);
  });

  test('every reason is a sentence, so a reader can disagree with a specific one', () => {
    const result = assessUpgrade(
      input({ security: { ...clean, resolved: [vuln('GHSA-1', 'high')], direction: 'improves' } }),
    );
    assert.ok(result.reasons.length > 0);
    assert.equal(result.reasons.every((r: string) => /[.!]$/.test(r)), true);
  });
});

describe('assembling the rationale', () => {
  const change = {
    name: 'pkg',
    ecosystem: 'npm' as const,
    from: '1.0.0',
    to: '2.0.0',
    kind: 'runtime' as const,
    bump: 'major' as const,
    manifestPath: 'package.json',
  };

  const noNetwork = { fetch: async () => null };

  // 'pkg' resolves to vercel/pkg, which is archived upstream — a confirmed
  // `polarity: 'blocks'` maintenance fact that a couple of the tests below
  // depend on to pin the recommendation. buildRationale learns it from two
  // live lookups (the npm packument, then the GitHub repo), and the GitHub
  // one is unauthenticated from CI and rate-limits intermittently, silently
  // degrading the fact — and the recommendation with it — to
  // "insufficient-evidence". Serve both lookups from a fixed response so the
  // assertions exercise the rationale logic rather than GitHub's rate limiter.
  const withArchivedPkg = async (run: () => Promise<void>) => {
    clearHttpCache();
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('https://registry.npmjs.org/pkg')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              repository: { url: 'git+https://github.com/vercel/pkg.git' },
              time: { '1.0.0': '2018-01-01T00:00:00Z', '2.0.0': '2020-01-27T00:00:00Z' },
              versions: { '1.0.0': { license: 'MIT' }, '2.0.0': { license: 'MIT' } },
            }),
          ),
        );
      }
      if (url === 'https://api.github.com/repos/vercel/pkg') {
        return Promise.resolve(
          new Response(
            JSON.stringify({ archived: true, pushed_at: '2023-01-27T00:00:00Z', html_url: 'https://github.com/vercel/pkg' }),
          ),
        );
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    }) as typeof fetch;
    try {
      await run();
    } finally {
      globalThis.fetch = realFetch;
      clearHttpCache();
    }
  };

  const osvResponse = (vulns: Record<string, unknown>[]) => ({ vulns });

  const vuln = (id: string, fixed: string, over: Record<string, unknown> = {}) => ({
    id,
    summary: `${id} summary.`,
    database_specific: { severity: 'HIGH' },
    affected: [{ ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed }] }] }],
    references: [{ type: 'ADVISORY', url: `https://example.test/${id}` }],
    ...over,
  });

  test('a failure is stated once, with its remedy attached rather than repeated', async () => {
    const surfaceGaps = new Map([
      [
        'npm pkg',
        {
          available: false as const,
          reason: 'tool-missing' as const,
          tool: 'go',
          detail: 'The Go toolchain is not installed, so pkg\'s exported API could not be compared.',
          remedy: 'Install Go 1.24 to enable exported-API comparison.',
        },
      ],
    ]);

    const [rationale] = await buildRationale(
      { changes: [change], evidence: [], breakingChanges: [], impactSites: [] },
      { config, logger, osv: noNetwork, surfaceGaps },
    );

    const toolchainMentions = rationale!.gaps.filter((g) => /Go toolchain is not installed/.test(g));
    assert.equal(toolchainMentions.length, 1, 'the same failure must not be stated twice');

    // The two absences are one situation and are said as one sentence.
    assert.match(toolchainMentions[0]!, /release notes, changelog, or migration guide/i);
    assert.match(toolchainMentions[0]!, /Install Go 1\.24/);
  });

  test('prose that was read and was calm is not reported as prose that is missing', async () => {
    const prose = new Map([
      [
        'pkg',
        [
          {
            kind: 'changelog' as const,
            label: 'CHANGELOG-v2.0.0.md',
            url: 'https://github.com/o/pkg/blob/main/CHANGELOG-v2.0.0.md',
            breaking: false,
          },
          {
            kind: 'migration-guide' as const,
            label: 'MIGRATION-GUIDE.md',
            url: 'https://github.com/o/pkg/blob/main/MIGRATION-GUIDE.md',
            breaking: false,
          },
        ],
      ],
    ]);

    const [rationale] = await buildRationale(
      { changes: [change], evidence: [], breakingChanges: [], impactSites: [] },
      { config, logger, osv: noNetwork, prose },
    );

    const stated = rationale!.gaps.find((g) => /changelog/i.test(g))!;

    // The claim Drift must never make is that nothing was published, when it
    // read what was published and simply found nothing alarming in it.
    assert.doesNotMatch(stated, /No release notes, changelog, or migration guide was reachable/);
    assert.match(stated, /Drift read/);
    assert.match(stated, /the changelog \(\[CHANGELOG-v2\.0\.0\.md\]\(https:\/\/github\.com\/o\/pkg\/blob\/main\/CHANGELOG-v2\.0\.0\.md\)\) and the migration guide \(\[MIGRATION-GUIDE\.md\]\(https:\/\/github\.com\/o\/pkg\/blob\/main\/MIGRATION-GUIDE\.md\)\)/);
  });

  test('a clean computed surface diff suppresses the prose-only caveat', async () => {
    const key = 'npm pkg';
    const prose = new Map([
      [
        key,
        [
          {
            kind: 'github-release' as const,
            label: 'v2.0.0 release notes',
            url: 'https://github.com/o/pkg/releases/tag/v2.0.0',
            breaking: false,
          },
        ],
      ],
    ]);

    const [rationale] = await buildRationale(
      { changes: [change], evidence: [], breakingChanges: [], impactSites: [] },
      {
        config,
        logger,
        osv: noNetwork,
        additions: new Map([[key, { additions: [], locator: 'pkg@1:index.d.ts → pkg@2:index.d.ts' }]]),
        surfaceCompared: new Set([key]),
        prose,
      },
    );

    assert.equal(rationale!.assessment.confidence, 'high');
    assert.doesNotMatch(rationale!.assessment.reasons.join(' '), /weaker than a clean API comparison/);
    assert.equal(rationale!.gaps.some((gap) => /found nothing.*announces a breaking change/.test(gap)), false);
  });

  test('many release notes link every one of them, instead of collapsing the rest into an unlinked count', async () => {
    const key = 'npm pkg';
    const releases = Array.from({ length: 5 }, (_, i) => ({
      kind: 'github-release' as const,
      label: `v2.0.${i} release notes`,
      url: `https://github.com/o/pkg/releases/tag/v2.0.${i}`,
      breaking: false,
    }));
    const prose = new Map([[key, releases]]);

    const [rationale] = await buildRationale(
      { changes: [change], evidence: [], breakingChanges: [], impactSites: [] },
      { config, logger, osv: noNetwork, prose },
    );

    const stated = rationale!.gaps.find((g) => /release notes/i.test(g))!;
    assert.match(stated, /\[v2\.0\.0 release notes\]\(https:\/\/github\.com\/o\/pkg\/releases\/tag\/v2\.0\.0\)/);
    assert.match(stated, /\[v2\.0\.2 release notes\]/);
    assert.match(stated, /\[v2\.0\.4 release notes\]/, 'the fifth is still a link, not a dead-end count');
    assert.doesNotMatch(stated, /and \d+ more/, 'nothing is hidden behind an unlinked count anymore');
  });

  test('repoRuntimeByWorkspace scopes a runtime declaration per member, even inside one buildRationale batch', async () => {
    // analyzeRepository's main path gathers changes from every workspace
    // member into a single buildRationale call. A flat repoRuntime applied
    // to all of them would let one member's declared Node floor leak into a
    // sibling member's compatibility verdict — this is what
    // repoRuntimeByWorkspace exists to prevent.
    //
    // fetchJson caches by URL for the lifetime of the process, and earlier
    // tests in this file already asked the (offline) network for this same
    // package and cached the miss — cleared here so the mock below is
    // actually consulted, and again after so later tests still see a miss
    // rather than this test's mocked packument.
    clearHttpCache();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            versions: {
              '1.0.0': { engines: { node: '>=14' } },
              '2.0.0': { engines: { node: '>=22.13.0' } },
            },
            time: {},
          }),
        ),
      )) as typeof fetch;

    try {
      const apiChange = { ...change, workspace: 'packages/api' };
      const workerChange = { ...change, workspace: 'packages/worker' };

      const rationales = await buildRationale(
        { changes: [apiChange, workerChange], evidence: [], breakingChanges: [], impactSites: [] },
        {
          config,
          logger,
          osv: noNetwork,
          repoRuntimeByWorkspace: new Map([
            ['packages/api', [{ file: 'packages/api/package.json', line: 1, requirement: '>=22.13.0' }]],
            ['packages/worker', [{ file: 'packages/worker/package.json', line: 1, requirement: '>=14' }]],
          ]),
        },
      );

      const factFor = (r: (typeof rationales)[number]) =>
        r.maintenance.facts.find((f) => /Node\.js version changed/.test(f.statement));

      // Maintenance states the same upstream fact for both members and
      // fabricates no per-member verdict — cross-member runtime scoping is now
      // the canonical discovery/analysis path's job (see rationale-runtime).
      for (const r of rationales) {
        assert.equal(factFor(r)?.concerning, false);
        assert.equal(factFor(r)?.polarity, 'context');
      }
    } finally {
      globalThis.fetch = realFetch;
      clearHttpCache();
    }
  });

  test('an unreadable dependency is insufficient evidence, and says so', async () => {
    await withArchivedPkg(async () => {
      const [rationale] = await buildRationale(
        { changes: [change], evidence: [], breakingChanges: [], impactSites: [] },
        { config, logger, osv: noNetwork },
      );

      // 'pkg' (vercel/pkg on GitHub) is archived upstream, which is itself a
      // confirmed, `polarity: 'blocks'` maintenance fact -- a real finding, not
      // an absence of one -- so it outranks "insufficient evidence" the same
      // way a known incompatibility would. The gap this test actually exercises
      // (OSV being unreachable) still has to surface regardless of which
      // recommendation wins.
      assert.equal(rationale!.assessment.recommendation, 'do-not-upgrade-yet');
      assert.ok(rationale!.gaps.some((g) => /OSV advisory database could not be reached/.test(g)));
    });
  });

  test('multiple upgrades use the OSV batch seam once', async () => {
    let batchCalls = 0;
    let singleCalls = 0;
    const other = { ...change, name: 'other', from: '3.0.0', to: '4.0.0' };

    const rationales = await buildRationale(
      { changes: [change, other], evidence: [], breakingChanges: [], impactSites: [] },
      {
        config,
        logger,
        osv: {
          fetch: async () => {
            singleCalls += 1;
            return null;
          },
          batchFetch: async (queries) => {
            batchCalls += 1;
            assert.equal(queries.length, 4);
            return queries.map((query) =>
              query.package.name === 'pkg' && query.version === '1.0.0'
                ? osvResponse([vuln('GHSA-fixed', '2.0.0')])
                : osvResponse([]),
            );
          },
        },
      },
    );

    assert.equal(batchCalls, 1);
    assert.equal(singleCalls, 0);
    assert.deepEqual(rationales.find((r) => r.dependency === 'pkg')!.security.resolved.map((v) => v.id), ['GHSA-fixed']);
  });

  test('the OSV batch runs concurrently with each dependency’s own metadata lookups, not in front of them', async () => {
    // buildRationale used to `await` the whole OSV batch before starting
    // rationaleFor for even the first dependency, so the registry/version
    // fetches for every dependency were serialized entirely behind OSV.
    clearHttpCache();
    const realFetch = globalThis.fetch;
    let osvResolved = false;
    let registryFetchObservedWhileOsvPending = false;

    globalThis.fetch = (() => {
      if (!osvResolved) registryFetchObservedWhileOsvPending = true;
      return Promise.resolve(new Response('not found', { status: 404 }));
    }) as typeof fetch;

    try {
      await buildRationale(
        { changes: [change], evidence: [], breakingChanges: [], impactSites: [] },
        {
          config,
          logger,
          osv: {
            batchFetch: async (queries) => {
              await new Promise((resolve) => setTimeout(resolve, 50));
              osvResolved = true;
              return queries.map(() => osvResponse([]));
            },
          },
        },
      );

      assert.equal(
        registryFetchObservedWhileOsvPending,
        true,
        'the registry lookup must start while the OSV batch is still in flight, not wait for it to resolve first',
      );
    } finally {
      globalThis.fetch = realFetch;
      clearHttpCache();
    }
  });

  test('switching a source off leaves it unchecked rather than clean', async () => {
    const quiet = DriftConfigSchema.parse({ rationale: { security: false } });
    const [rationale] = await buildRationale(
      { changes: [change], evidence: [], breakingChanges: [], impactSites: [] },
      { config: quiet, logger, osv: noNetwork },
    );
    assert.equal(rationale!.security.checked, false);
  });

  test('the rendered block leads with the recommendation and ends with its reasons', async () => {
    await withArchivedPkg(async () => {
      const [rationale] = await buildRationale(
        { changes: [change], evidence: [], breakingChanges: [], impactSites: [] },
        { config, logger, osv: noNetwork },
      );

      const markdown = renderOne(rationale!);
      const lines = markdown.split('\n').filter(Boolean);
      assert.match(lines[0]!, /^### `pkg` 1\.0\.0 → 2\.0\.0$/);
      // 'pkg' is archived upstream (see the test above), a confirmed
      // `polarity: 'blocks'` fact that now outranks "insufficient evidence".
      assert.match(lines[1]!, /^\*\*Recommendation: Do not upgrade yet\*\*$/);
      assert.match(markdown, /Why Drift concluded this/);
    });
  });

  test('progress is reported in named stages, not as one opaque phase', async () => {
    const phases: string[] = [];
    await buildRationale(
      { changes: [change], evidence: [], breakingChanges: [], impactSites: [] },
      { config, logger, osv: noNetwork, onProgress: (_change, phase) => phases.push(phase) },
    );

    // `prepareRationaleFacts` (workspace-independent: registry, versions,
    // repository status, security, license) now runs before
    // `finalizeRationale` (workspace-sensitive: maintenance onward) — see
    // `src/rationale/index.ts`. License moved earlier because it depends only
    // on package-level facts, not on this repository's own runtime.
    assert.deepEqual(phases.filter((phase) => !/rate limited, retrying/.test(phase)), [
      'Checking package metadata',
      'Checking repository status',
      'Checking security advisories',
      'Checking license',
      'Checking maintenance signals',
    ]);
    assert.equal(phases.every((phase) => phase.startsWith('Checking ')), true, 'retry progress remains a named stage');
  });
});

describe('rendering the license section', () => {
  const baseRationale = (license: import('../dist/rationale/types.js').LicenseFinding) =>
    ({
      dependency: 'pkg',
      from: '1.0.0',
      to: '2.0.0',
      security: { checked: false, current: [], target: [], resolved: [], introduced: [], carried: [], direction: 'preserves' },
      maintenance: { facts: [] },
      improvements: [],
      license,
      summary: { changes: [], unrelated: 0 },
      assessment: {
        recommendation: 'safe-to-upgrade',
        reasons: [],
        confidence: 'low',
        confidenceBasis: '',
      },
      gaps: [],
    }) as unknown as import('../dist/rationale/types.js').UpgradeRationale;

  test('a benign license change is silent', () => {
    const markdown = renderOne(baseRationale({ verdict: 'changed', statement: 'The declared license changed from MIT to BSD-3-Clause.', introduced: [] }));
    assert.doesNotMatch(markdown, /License/);
  });

  test('an unchanged license is silent', () => {
    const markdown = renderOne(baseRationale({ verdict: 'ok', statement: 'The license is unchanged.', introduced: [] }));
    assert.doesNotMatch(markdown, /License/);
  });

  test('a license that stopped being readable is shown', () => {
    const markdown = renderOne(baseRationale({ verdict: 'unknown', statement: 'pkg 2.0.0 declares no license Drift could read.', introduced: [] }));
    assert.match(markdown, /\*\*License\*\*/);
    assert.match(markdown, /declares no license Drift could read/);
  });

  test('a policy violation is shown, with its own heading', () => {
    const markdown = renderOne(baseRationale({ verdict: 'policy-violation', statement: 'AGPL now.', introduced: [] }));
    assert.match(markdown, /\*\*License review required\*\*/);
    assert.match(markdown, /AGPL now\./);
  });
});
