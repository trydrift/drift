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
 * The core behavior under test: one alert per *package*, not one per
 * breaking change and not one per upstream change. A breaking change with
 * no impact site in this repository is never itemized in that alert —
 * that's the fix for the 347-alert-body flood a single outdated `zod`
 * upgrade produced in this repository (nearly all of those upstream changes
 * touched no code here) — but every locally-actionable breaking change and
 * security signal a package does have folds into its one alert as its own
 * block, listed one after another rather than merged into one paragraph.
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

const site = (breakingChangeId: string, overrides: Record<string, unknown> = {}) => ({
  breakingChangeId,
  file: 'src/index.ts',
  line: 12,
  excerpt: 'createClient()',
  matchedSymbol: 'createClient',
  confidence: 'high' as const,
  ...overrides,
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
  test('one finding per package, folding every locally-actionable breaking change into its own block', async () => {
    const plan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence,
      breakingChanges: [breaking('bc_1'), breaking('bc_2')],
      impactSites: [site('bc_1'), site('bc_2')],
    }) as RemediationPlan;

    const findings = await findingsFromPlan(plan);
    assert.equal(findings.length, 1, 'one finding per package, not one per breaking change');
    assert.equal(findings[0]!.ruleId, 'drift/npm/acme-sdk', 'rule is stable per package, so a rescan replaces it');
    assert.equal(findings[0]!.level, 'error', 'high upstream confidence + high local confidence is an error');
    assert.match(findings[0]!.message, /createClient.*was removed \(bc_1\)/);
    assert.match(findings[0]!.message, /createClient.*was removed \(bc_2\)/);
    assert.match(findings[0]!.message, /---/, 'each breaking change is its own block, separated by a rule');
    assert.equal(
      findings[0]!.primaryLocation.file,
      dependencyChange.manifestPath,
      'package granularity anchors to the manifest, not one arbitrarily-chosen call site',
    );
    assert.equal(findings[0]!.primaryLocation.line, 1);
    assert.match(findings[0]!.message, /Seen at.*src\/index\.ts:12/s, 'the actual call site is still listed');
  });

  test('a breaking change with no impact site is omitted from the alert body, not the whole alert', async () => {
    const plan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence,
      breakingChanges: [breaking('bc_1'), breaking('bc_2')],
      impactSites: [site('bc_1')], // bc_2 reaches no code in this repo
    }) as RemediationPlan;

    const findings = await findingsFromPlan(plan);
    assert.equal(findings.length, 1);
    assert.match(findings[0]!.message, /bc_1/);
    assert.doesNotMatch(findings[0]!.message, /bc_2/, 'the upstream-only change is not itemized');
    assert.match(findings[0]!.message, /1 additional upstream breaking change/);
  });

  test('multiple sites for the same breaking change: one alert, one primary location, the rest related', async () => {
    const plan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence,
      breakingChanges: [breaking('bc_1')],
      impactSites: [
        site('bc_1', { file: 'src/a.ts', line: 1 }),
        site('bc_1', { file: 'src/b.ts', line: 2 }),
      ],
    }) as RemediationPlan;

    const [finding] = await findingsFromPlan(plan);
    assert.equal(finding!.primaryLocation.file, dependencyChange.manifestPath);
    assert.equal(finding!.relatedLocations.length, 2);
    assert.equal(finding!.relatedLocations[0]!.file, 'src/a.ts');
    assert.equal(finding!.relatedLocations[1]!.file, 'src/b.ts');
  });

  test('upstream-only confidence downgrades severity when local confidence is weaker', async () => {
    const plan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence,
      breakingChanges: [breaking('bc_1', { confidence: 'high' })],
      impactSites: [site('bc_1', { confidence: 'medium' })],
    }) as RemediationPlan;

    const [finding] = await findingsFromPlan(plan);
    assert.equal(finding!.level, 'warning', 'one strong signal but not two is a warning, not an error');
  });

  test('a resolved advisory is alerted even with no breaking change', async () => {
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

    const findings = await findingsFromPlan(plan);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.ruleId, 'drift/npm/acme-sdk');
    assert.equal(findings[0]!.level, 'note', 'resolving an advisory with nothing broken is informational');
    assert.match(findings[0]!.message, /GHSA-xxxx/);
    assert.equal(findings[0]!.helpUri, 'https://example.com/advisory');
  });

  test('a plain version bump with no signal is dropped by default', async () => {
    const plan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence,
      breakingChanges: [],
      impactSites: [],
      rationale: [rationale({ security: { ...cleanSecurity, checked: false, direction: 'unknown' } })],
    }) as RemediationPlan;

    assert.equal((await findingsFromPlan(plan)).length, 0, 'includeInformational defaults to false');
    assert.equal((await findingsFromPlan(plan, { includeInformational: true })).length, 1);
    const [finding] = await findingsFromPlan(plan, { includeInformational: true });
    assert.equal(finding!.ruleId, 'drift/npm/acme-sdk');
    assert.equal(
      finding!.ruleName,
      'acme-sdk: Outdated — safe to upgrade',
      'a package with nothing but a safe update gets a rule name that says so, not the generic "dependency finding"',
    );
  });

  test('a package with a breaking change AND a security signal keeps the generic rule name', async () => {
    const plan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence,
      breakingChanges: [breaking('bc_1')],
      impactSites: [site('bc_1')],
      rationale: [
        rationale({
          security: {
            ...cleanSecurity,
            resolved: [
              {
                id: 'GHSA-xxxx',
                aliases: [],
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

    const [finding] = await findingsFromPlan(plan);
    assert.equal(finding!.ruleName, 'acme-sdk: dependency finding', 'no single short label fits more than one block');
  });

  test('an unresolved current advisory is an error', async () => {
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

    const [finding] = await findingsFromPlan(plan);
    assert.equal(finding!.level, 'error');
  });

  test('package granularity (default) never carries a snippet', async () => {
    const plan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence,
      breakingChanges: [breaking('bc_1')],
      impactSites: [site('bc_1')],
    }) as RemediationPlan;

    const [finding] = await findingsFromPlan(plan);
    assert.ok(!finding!.snippetOk, 'bundling many possible issues under one alert makes any one snippet arbitrary');
  });

  test('every "Seen at" link resolves to a real repo URL, including sites beyond the related-locations cap', async () => {
    // 11 breaking changes, one site each — more than MAX_RELATED_LOCATIONS
    // (9), so some sites fall outside the numeric relatedLocations id space
    // and must fall back to an absolute blob URL rather than a broken
    // relative link.
    const ids = Array.from({ length: 11 }, (_, i) => `bc_${i}`);
    const plan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence,
      breakingChanges: ids.map((id) => breaking(id)),
      impactSites: ids.map((id) => site(id, { file: `src/${id}.ts`, line: 1 })),
    }) as RemediationPlan;

    const [finding] = await findingsFromPlan(plan, { repoBlobUrl: 'https://github.com/acme/app/blob/deadbeef' });
    for (const id of ids) {
      assert.match(
        finding!.message,
        new RegExp(`\\[\`src/${id}\\.ts:1\`\\]\\((?:\\d+|https://github\\.com/acme/app/blob/deadbeef/src/${id}\\.ts#L1)\\)`),
        `${id}'s site link is either a jump-to-file id or a real blob URL, never a bare relative path`,
      );
    }
    assert.doesNotMatch(finding!.message, /\]\(src\//, 'no link is left as a bare relative path');
  });

  test('breakingChange granularity: one alert per breaking change, each with its own stable ruleId and a representative snippet', async () => {
    const plan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence,
      breakingChanges: [breaking('bc_1'), breaking('bc_2')],
      impactSites: [site('bc_1', { file: 'src/a.ts' }), site('bc_2', { file: 'src/b.ts' })],
    }) as RemediationPlan;

    const findings = await findingsFromPlan(plan, { granularity: 'breakingChange' });
    assert.equal(findings.length, 2, 'one alert per breaking change');
    const ruleIds = findings.map((f) => f.ruleId);
    assert.ok(new Set(ruleIds).size === 2, 'ruleIds are distinct');
    for (const f of ruleIds) assert.match(f, /^drift\/npm\/acme-sdk\/bc_\d$/);
    for (const finding of findings) assert.ok(finding.snippetOk, 'scoped to one breaking change, so its primary site is representative');

    // rescanning the same plan produces the same ruleIds, so GitHub replaces each alert in place
    const again = await findingsFromPlan(plan, { granularity: 'breakingChange' });
    assert.deepEqual(again.map((f) => f.ruleId).sort(), ruleIds.sort());
  });

  test('the declaration source link carries a text fragment to the changed declaration, not just the top of the file', async () => {
    const plan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence,
      breakingChanges: [
        breaking('bc_1', {
          kind: 'signature-change',
          before: 'declare const boolean: (params?: RawCreateParams) => ZodBoolean;',
          after: 'declare function boolean<T = unknown>(params?: string): ZodCoercedBoolean<T>;',
        }),
      ],
      impactSites: [site('bc_1')],
    }) as RemediationPlan;

    const [finding] = await findingsFromPlan(plan, { granularity: 'breakingChange' });
    assert.match(finding!.helpUri!, /^https:\/\/example\.com\/diff#:~:text=/, 'a text fragment is appended to the cited URL');
    assert.match(
      decodeURIComponent(finding!.helpUri!.split('#:~:text=')[1]!),
      /declare function boolean/,
      'the fragment targets the changed (after) declaration',
    );
  });

  test('the before/after declaration diff escapes angle brackets so a code span cannot be mistaken for an HTML tag', async () => {
    const plan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence,
      breakingChanges: [
        breaking('bc_1', {
          kind: 'signature-change',
          before: 'declare const boolean: (params?: RawCreateParams & { coerce?: boolean }) => ZodBoolean;',
          after: 'declare function boolean<T = unknown>(params?: string): ZodCoercedBoolean<T>;',
        }),
      ],
      impactSites: [site('bc_1')],
    }) as RemediationPlan;

    const [finding] = await findingsFromPlan(plan, { granularity: 'breakingChange' });
    assert.match(finding!.message, /ZodCoercedBoolean&lt;T&gt;/, 'angle brackets are HTML-escaped inside the code span');
    assert.doesNotMatch(finding!.message, /ZodCoercedBoolean<T>/, 'the raw, unescaped angle brackets never reach the markdown');

    // The plain-text fallback (SARIF requires message.text) unescapes them
    // back, since it is never parsed as markdown/HTML in the first place.
    const log = buildSarifLog(await findingsFromPlan(plan, { granularity: 'breakingChange' })) as {
      runs: [{ results: [{ message: { text: string } }] }];
    };
    assert.match(log.runs[0].results[0]!.message.text, /ZodCoercedBoolean<T>/);
  });

  test('breakingChange granularity: rule names include the symbol, so same-kind alerts are distinguishable', async () => {
    const plan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence,
      breakingChanges: [
        breaking('bc_1', { symbols: ['createClient'] }),
        breaking('bc_2', { symbols: ['closeClient'] }),
      ],
      impactSites: [site('bc_1', { file: 'src/a.ts' }), site('bc_2', { file: 'src/b.ts' })],
    }) as RemediationPlan;

    const findings = await findingsFromPlan(plan, { granularity: 'breakingChange' });
    const ruleNames = findings.map((f) => f.ruleName);
    assert.ok(new Set(ruleNames).size === 2, 'rule names are distinct when the symbols differ');
    for (const name of ruleNames) {
      assert.match(name, /^acme-sdk: Removed export used in this repository \((createClient|closeClient)\)$/);
    }
  });

  test('affectedSite granularity: one alert per call site, none carrying related locations', async () => {
    const plan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence,
      breakingChanges: [breaking('bc_1')],
      impactSites: [
        site('bc_1', { file: 'src/a.ts', line: 1 }),
        site('bc_1', { file: 'src/b.ts', line: 2 }),
      ],
    }) as RemediationPlan;

    const findings = await findingsFromPlan(plan, { granularity: 'affectedSite' });
    assert.equal(findings.length, 2, 'one alert per call site, not per breaking change');
    const files = findings.map((f) => f.primaryLocation.file).sort();
    assert.deepEqual(files, ['src/a.ts', 'src/b.ts']);
    for (const finding of findings) {
      assert.equal(finding.relatedLocations.length, 0, 'a site alert is scoped to exactly one location');
      assert.ok(finding.snippetOk, 'exactly one site per alert, so its snippet is never a stand-in for another');
    }
    assert.notEqual(findings[0]!.ruleId, findings[1]!.ruleId);
  });

  test('a security signal always gets its own single alert, regardless of granularity', async () => {
    const plan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence,
      breakingChanges: [breaking('bc_1')],
      impactSites: [site('bc_1')],
      rationale: [
        rationale({
          security: {
            ...cleanSecurity,
            resolved: [
              {
                id: 'GHSA-xxxx',
                aliases: [],
                summary: 'Prototype pollution',
                severity: 'high',
                url: 'https://example.com/advisory',
                fixedIn: '2.0.0',
              },
            ],
          },
        }),
      ],
    }) as RemediationPlan;

    const findings = await findingsFromPlan(plan, { granularity: 'affectedSite' });
    // one alert per call site for the breaking change, plus exactly one for security
    assert.equal(findings.length, 2);
    const securityFinding = findings.find((f) => f.ruleId.endsWith('/other'));
    assert.ok(securityFinding, 'the security block gets its own alert, suffixed distinctly from any site alert');
    assert.match(securityFinding!.message, /Resolves 1 known advisory/);
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

  test('a safe candidate with no commits gets the exact upgrade command as its fix', async () => {
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
    const [finding] = await findingsFromCandidates([candidate], { includeInformational: true });

    assert.ok(finding, 'a candidate with a plan produces a finding');
    assert.equal(plan.commits.length, 0, 'a clean candidate has nothing to commit');
    assert.ok(finding!.fix?.command, 'the fix names the exact command to run');
    assert.match(finding!.fix!.command!, /1\.2\.0/);
  });

  test('a safe candidate produces no finding when informational alerts are off', async () => {
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
    assert.equal((await findingsFromCandidates([candidate])).length, 0);
  });

  test('a candidate with no plan produces no finding', async () => {
    assert.equal((await findingsFromCandidates([{ ...baseCandidate }])).length, 0);
  });

  test('a failed verification produces a finding even with zero breaking changes and impact sites', async () => {
    const plan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [{ ...dependencyChange, from: '1.0.0', to: '1.2.0' }],
      evidence: [],
      breakingChanges: [],
      impactSites: [],
      rationale: [rationale({ from: '1.0.0', to: '1.2.0' })],
    }) as RemediationPlan;
    plan.verification = {
      status: 'failed',
      checks: [{ kind: 'typecheck', label: 'npm run typecheck', compileCapable: true, status: 'failed', durationMs: 1, output: 'boom' }],
      diagnostics: 'src/a.ts(1,1): error TS2554',
      failedFiles: ['src/a.ts'],
    };

    const candidate: UpgradeCandidate = {
      ...baseCandidate,
      verification: plan.verification,
      plan,
    };

    // No `includeInformational` — this must not depend on that flag, unlike
    // the ordinary "safe to upgrade" informational block.
    const findings = await findingsFromCandidates([candidate]);
    assert.equal(findings.length, 1, 'a failed verification is never silent, even with nothing else to report');
    assert.match(findings[0]!.message, /own checks fail/i);
    assert.match(findings[0]!.message, /npm run typecheck/);
    assert.doesNotMatch(findings[0]!.fix?.description ?? '', /Safe to upgrade/);
  });

  test('a passing verification with nothing found is still described as safe', async () => {
    const plan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [{ ...dependencyChange, from: '1.0.0', to: '1.2.0' }],
      evidence: [],
      breakingChanges: [],
      impactSites: [],
      rationale: [rationale({ from: '1.0.0', to: '1.2.0' })],
    }) as RemediationPlan;
    plan.verification = {
      status: 'passed',
      checks: [{ kind: 'typecheck', label: 'npm run typecheck', compileCapable: true, status: 'passed', durationMs: 1, output: '' }],
      failedFiles: [],
    };

    const candidate: UpgradeCandidate = { ...baseCandidate, verification: plan.verification, plan };
    const [finding] = await findingsFromCandidates([candidate], { includeInformational: true });
    assert.match(finding!.fix?.description ?? '', /Safe to upgrade/);
  });
});

describe('buildSarifLog', () => {
  test('one rule per ruleId, one result per finding, with a category and a fingerprint', async () => {
    const plan = buildPlan({
      repo,
      config: DEFAULT_CONFIG,
      changes: [dependencyChange],
      evidence,
      breakingChanges: [breaking('bc_1')],
      impactSites: [site('bc_1')],
    }) as RemediationPlan;

    const log = buildSarifLog(await findingsFromPlan(plan), 'drift/diff') as {
      runs: [
        {
          tool: { driver: { rules: unknown[] } };
          automationDetails?: { id: string };
          results: { partialFingerprints: { primaryLocationLineHash: string } }[];
        },
      ];
    };

    assert.equal(log.runs[0]!.tool.driver.rules.length, 1);
    assert.equal(log.runs[0]!.results.length, 1);
    assert.equal(log.runs[0]!.automationDetails?.id, 'drift/diff');
    assert.ok(log.runs[0]!.results[0]!.partialFingerprints.primaryLocationLineHash.length > 0);
  });

  test('an empty finding list is still a valid, empty SARIF log', async () => {
    const log = buildSarifLog([]) as { runs: [{ results: unknown[] }] };
    assert.equal(log.runs[0]!.results.length, 0);
  });
});
