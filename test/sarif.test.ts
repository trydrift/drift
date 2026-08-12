import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildSarifLog, findingsFromCandidates, findingsFromPlan } from '../dist/report/sarif.js';
import { buildPlan } from '../dist/plan/index.js';
import { DEFAULT_CONFIG } from '../dist/config/schema.js';
import type { RemediationPlan } from '../dist/types.js';
import type { UpgradeCandidate } from '../dist/upgrade/scan.js';
import type { UpgradeRationale } from '../dist/rationale/types.js';

/**
 * SARIF findings: what a repository sees in its Security tab.
 *
 * The assertions here mirror the extension's inline diagnostics — evidence,
 * location, and a fix, grouped one alert per package rather than one per
 * breaking change or advisory — because that grouping, and never losing the
 * fix line, is the whole point of this module.
 */

const repo = {
  owner: 'acme',
  repo: 'app',
  baseBranch: 'main',
  beforeSha: 'a'.repeat(40),
  afterSha: 'b'.repeat(40),
};

const dependencyChange = {
  name: 'acme-sdk',
  ecosystem: 'npm' as const,
  from: '1.0.0',
  to: '2.0.0',
  kind: 'runtime' as const,
  bump: 'major' as const,
  manifestPath: 'package.json',
};

const evidence = [
  {
    id: 'ev_1',
    source: 'type-surface-diff' as const,
    dependency: 'acme-sdk',
    url: 'https://example.com/diff',
    title: 'API surface diff',
    content: '`createClient` removed',
    weight: 1,
  },
];

function breaking(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    dependency: 'acme-sdk',
    kind: 'removed-export' as const,
    summary: `\`createClient\` was removed (${id}).`,
    remediation: 'Replace every usage of `createClient`.',
    symbols: ['createClient'],
    confidence: 'high' as const,
    citations: ['ev_1'],
    ...overrides,
  };
}

const site = (breakingChangeId: string) => ({
  breakingChangeId,
  file: 'src/index.ts',
  line: 12,
  excerpt: 'createClient()',
  matchedSymbol: 'createClient',
  confidence: 'high' as const,
});

const cleanSecurity = {
  checked: true,
  current: [],
  target: [],
  resolved: [],
  introduced: [],
  carried: [],
  direction: 'unknown' as const,
};

function rationale(overrides: Partial<UpgradeRationale> = {}): UpgradeRationale {
  return {
    dependency: 'acme-sdk',
    from: '1.0.0',
    to: '2.0.0',
    security: cleanSecurity,
    maintenance: { facts: [] },
    improvements: [],
    license: { verdict: 'ok', statement: 'No license change.', introduced: [] },
    summary: { changes: [], unrelated: 0 },
    assessment: {
      recommendation: 'safe-to-upgrade',
      reasons: ['No breaking changes were found.'],
      confidence: 'high',
      confidenceBasis: 'A computed API diff was available.',
    },
    gaps: [],
    ...overrides,
  };
}

describe('findingsFromPlan', () => {
  test('one finding per package, however many breaking changes it has', () => {
    const plan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence,
      breakingChanges: [breaking('bc_1'), breaking('bc_2')],
      impactSites: [site('bc_1'), site('bc_2')],
    }) as RemediationPlan;

    const findings = findingsFromPlan(plan);
    assert.equal(findings.length, 1, 'one finding per package, not per breaking change');
    assert.equal(findings[0]!.ruleId, 'drift/npm/acme-sdk', 'stable id, independent of which breaking changes exist');
    assert.equal(findings[0]!.level, 'error', 'high-confidence breaking change is an error');
    assert.match(findings[0]!.message, /bc_1/);
    assert.match(findings[0]!.message, /bc_2/);
    assert.equal(findings[0]!.locations[0]!.file, 'src/index.ts');
    assert.equal(findings[0]!.locations[0]!.line, 12);
  });

  test('lists every location any of the package\'s breaking changes reach', () => {
    const plan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence,
      breakingChanges: [breaking('bc_1'), breaking('bc_2')],
      impactSites: [
        { ...site('bc_1'), file: 'src/a.ts', line: 1 },
        { ...site('bc_2'), file: 'src/b.ts', line: 2 },
      ],
    }) as RemediationPlan;

    const [finding] = findingsFromPlan(plan);
    assert.equal(finding!.locations.length, 2);
    assert.deepEqual(
      finding!.locations.map((l) => l.file),
      ['src/a.ts', 'src/b.ts'],
    );
    assert.match(finding!.message, /2 location\(s\) across 2 file\(s\)/);
  });

  test('a resolved advisory is alerted even with no breaking change', () => {
    const plan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence,
      breakingChanges: [],
      impactSites: [],
      rationale: [
        rationale({
          security: {
            ...cleanSecurity,
            resolved: [
              {
                id: 'GHSA-xxxx',
                aliases: ['CVE-2024-1'],
                summary: 'Prototype pollution',
                severity: 'high',
                url: 'https://example.com/advisory',
                fixedIn: '2.0.0',
              },
            ],
            direction: 'improves',
          },
        }),
      ],
    }) as RemediationPlan;

    const findings = findingsFromPlan(plan);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.level, 'note', 'resolving an advisory with nothing broken is informational');
    assert.match(findings[0]!.message, /GHSA-xxxx/);
    assert.equal(findings[0]!.helpUri, 'https://example.com/advisory');
  });

  test('a plain version bump with no signal is dropped when informational findings are off', () => {
    const plan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence,
      breakingChanges: [],
      impactSites: [],
      rationale: [rationale({ security: { ...cleanSecurity, checked: false, direction: 'unknown' } })],
    }) as RemediationPlan;

    assert.equal(findingsFromPlan(plan, { includeInformational: false }).length, 0);
    assert.equal(findingsFromPlan(plan, { includeInformational: true }).length, 1);
  });

  test('an unresolved current advisory is an error', () => {
    const plan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence,
      breakingChanges: [],
      impactSites: [],
      rationale: [
        rationale({
          security: {
            ...cleanSecurity,
            current: [
              {
                id: 'GHSA-yyyy',
                aliases: [],
                summary: 'Remote code execution',
                severity: 'critical',
                url: 'https://example.com/rce',
                fixedIn: null,
              },
            ],
            direction: 'preserves',
          },
        }),
      ],
    }) as RemediationPlan;

    const [finding] = findingsFromPlan(plan);
    assert.equal(finding!.level, 'error');
  });
});

describe('findingsFromCandidates', () => {
  const baseCandidate: UpgradeCandidate = {
    id: 'cand_1',
    name: 'acme-sdk',
    kind: 'runtime',
    ecosystem: 'npm',
    packageManager: 'npm',
    manifestPath: 'package.json',
    current: '1.0.0',
    range: '^1.0.0',
    selected: '1.2.0',
    latest: '1.2.0',
    versions: ['1.2.0'],
    status: 'clean',
    evidenceCount: 1,
    breakingCount: 0,
    impactCount: 0,
    impactFiles: 0,
    risk: 'none',
    summary: 'No breaking changes found.',
    gaps: [],
    toolRequests: [],
  };

  test('a safe candidate with no commits gets the exact upgrade command as its fix', () => {
    const plan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [{ ...dependencyChange, from: '1.0.0', to: '1.2.0' }],
      evidence: [],
      breakingChanges: [],
      impactSites: [],
      rationale: [rationale({ from: '1.0.0', to: '1.2.0' })],
    }) as RemediationPlan;

    const candidate: UpgradeCandidate = { ...baseCandidate, plan };
    const [finding] = findingsFromCandidates([candidate]);

    assert.ok(finding, 'a candidate with a plan produces a finding');
    assert.equal(plan.commits.length, 0, 'a clean candidate has nothing to commit');
    assert.ok(finding!.fix?.command, 'the fix names the exact command to run');
    assert.match(finding!.fix!.command!, /1\.2\.0/);
  });

  test('a candidate with no plan produces no finding', () => {
    assert.equal(findingsFromCandidates([{ ...baseCandidate }]).length, 0);
  });
});

describe('buildSarifLog', () => {
  test('one rule per ruleId, one result per finding', () => {
    const plan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence,
      breakingChanges: [breaking('bc_1')],
      impactSites: [site('bc_1')],
    }) as RemediationPlan;

    const log = buildSarifLog(findingsFromPlan(plan)) as {
      runs: [{ tool: { driver: { rules: unknown[] } }; results: unknown[] }];
    };

    assert.equal(log.runs[0]!.tool.driver.rules.length, 1);
    assert.equal(log.runs[0]!.results.length, 1);
  });

  test('an empty finding list is still a valid, empty SARIF log', () => {
    const log = buildSarifLog([]) as { runs: [{ results: unknown[] }] };
    assert.equal(log.runs[0]!.results.length, 0);
  });
});
