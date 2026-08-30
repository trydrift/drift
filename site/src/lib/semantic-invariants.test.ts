import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateSemanticInvariants } from '../../scripts/semantic-recording-validation.mjs';

/**
 * A structurally valid recording is not a semantically sane one.
 *
 * The structural validator accepted every one of the recordings that carried
 * the launch audit's findings: a Ruby platform suffix rendered as a version
 * movement, a transport failure phrased as a fact about a package, a Cargo
 * progress line recorded as the cause of a build failure, a clean verdict
 * standing on a search that was never finished. These are the shapes that may
 * not come back quietly.
 */

interface CandidateOverrides {
  [key: string]: unknown;
}

function recording(candidates: CandidateOverrides[]): Record<string, unknown> {
  return {
    id: 'demo',
    ecosystem: 'npm',
    candidates: candidates.map((candidate) => ({
      name: 'demo-package',
      ecosystem: 'npm',
      current: '1.0.0',
      selected: '2.0.0',
      latest: '2.0.0',
      severity: 'affected',
      breakingCount: 1,
      impactCount: 1,
      hasCompatibilityEvidence: true,
      gaps: [],
      evidenceGaps: [],
      breaking: [],
      ...candidate,
    })),
  };
}

function rejects(candidates: CandidateOverrides[], pattern: RegExp): void {
  assert.throws(() => validateSemanticInvariants(recording(candidates), 'demo.json'), pattern);
}

function accepts(candidates: CandidateOverrides[]): void {
  assert.doesNotThrow(() => validateSemanticInvariants(recording(candidates), 'demo.json'));
}

describe('a selected target is a published release, not a normalization', () => {
  test('a spelling difference is not an upgrade', () => {
    rejects([{ ecosystem: 'pypi', current: '0.23', selected: '0.23.0' }], /normalization of the installed/);
    rejects([{ ecosystem: 'go', current: 'v0.17.0', selected: '0.17.0' }], /normalization of the installed/);
    rejects([{ ecosystem: 'npm', current: '1.2.0', selected: '1.2' }], /normalization of the installed/);
  });

  test('a real release move is fine, and a prerelease is a different release', () => {
    accepts([{ current: '1.0.0', selected: '2.0.0' }]);
    accepts([{ ecosystem: 'pypi', current: '0.8.0rc1', selected: '0.8.0' }]);
  });
});

describe('a Ruby platform is not a version', () => {
  test('a Gem::Platform suffix in any version field is rejected', () => {
    for (const field of ['current', 'selected', 'latest'] as const) {
      rejects(
        [{ ecosystem: 'rubygems', current: '4.36.0', selected: '4.36.0', [field]: '4.36.0-x86_64-linux-gnu' }],
        /Gem::Platform suffix/,
      );
    }
    rejects([{ ecosystem: 'rubygems', current: '2.3.4-java', selected: '2.3.5' }], /Gem::Platform suffix/);
  });

  test('a real Gem::Version qualifier survives', () => {
    accepts([{ ecosystem: 'rubygems', current: '4.0.0.beta1', selected: '4.0.0' }]);
    accepts([{ ecosystem: 'rubygems', current: '1.0.0-rc1', selected: '1.0.0' }]);
  });
});

describe('a confident removal rests on evidence that could establish it', () => {
  const removal = (evidence: { source: string }[], extra: CandidateOverrides = {}) => [
    {
      breaking: [
        {
          kind: 'removed-export',
          summary: '`foo` is no longer exported.',
          confidence: 'high',
          evidence,
          sites: [],
          ...extra,
        },
      ],
    },
  ];

  test('prose alone cannot carry a high-confidence removal', () => {
    rejects(removal([{ source: 'changelog' }]), /an absence claim needs a computed artifact comparison/);
  });

  test('no evidence cannot carry a high-confidence removal', () => {
    rejects(removal([]), /an absence claim needs a computed artifact comparison/);
  });

  test('a computed comparison can', () => {
    accepts(removal([{ source: 'type-surface-diff' }]));
    accepts(removal([{ source: 'changelog' }, { source: 'type-surface-diff' }]));
  });

  test('a require() incompatibility claim must agree with its own metadata', () => {
    rejects(
      [
        {
          breaking: [
            {
              kind: 'module-system-change',
              summary: 'The package no longer exposes a CommonJS-compatible entry point',
              confidence: 'high',
              evidence: [{ source: 'type-surface-diff' }],
              moduleSystem: { from: 'dual', to: 'dual', incompatibleUsage: ['require'] },
              sites: [],
            },
          ],
        },
      ],
      /claims require\(\) incompatibility while its own metadata records the target as dual/,
    );
  });
});

describe('a gap says what actually happened', () => {
  test('an absence cannot be claimed when nothing was inspected', () => {
    rejects(
      [
        {
          gaps: ['demo-package publishes no TypeScript declarations Drift could compare.'],
          evidenceGaps: [{ code: 'artifact-unavailable', tool: 'TypeScript declarations' }],
        },
      ],
      /every gap code says the artifact was never inspected/,
    );
  });

  test('an absence proven by inspection is fine', () => {
    accepts([
      {
        gaps: ['demo-package publishes no TypeScript declarations Drift could compare.'],
        evidenceGaps: [{ code: 'no-public-surface', tool: 'TypeScript declarations' }],
      },
    ]);
  });

  test('a known package role is not a missing artifact', () => {
    rejects(
      [
        {
          gaps: ['Maven Central has no jar for org.example:parent:1.0.0.'],
          evidenceGaps: [{ code: 'artifact-role-unsupported', tool: 'japicmp' }],
        },
      ],
      /known package role is reported as a missing artifact/,
    );
  });

  test('a Cargo failure is not reported as progress output', () => {
    rejects(
      [
        {
          gaps: ['`cargo public-api` failed on anyhow 1.0.86: Updating crates.io index'],
          evidenceGaps: [{ code: 'toolchain-failed', tool: 'cargo public-api' }],
        },
      ],
      /Cargo failure is reported as progress output/,
    );
    accepts([
      {
        gaps: ['`cargo public-api` failed on anyhow 1.0.86: error: failed to run custom build command'],
        evidenceGaps: [{ code: 'toolchain-failed', tool: 'cargo public-api' }],
      },
    ]);
  });
});

describe('uncertainty does not become clean', () => {
  test('an incomplete search cannot earn a clean verdict about absence', () => {
    rejects(
      [
        {
          severity: 'clean',
          breakingCount: 2,
          impactCount: 0,
          sourceCoverage: { localizationRan: true, localizationComplete: false },
        },
      ],
      /clean verdict rests on finding no local use/,
    );
  });

  test('a package with nothing breaking upstream is clean on upstream evidence', () => {
    // Nothing to look for means incomplete coverage is irrelevant.
    accepts([
      {
        severity: 'clean',
        breakingCount: 0,
        impactCount: 0,
        sourceCoverage: { localizationRan: true, localizationComplete: false },
      },
    ]);
  });

  test('positive sites survive truncation rather than being erased', () => {
    rejects(
      [
        {
          severity: 'localization-incomplete',
          breakingCount: 1,
          impactCount: 3,
          sourceCoverage: { localizationRan: true, localizationComplete: false },
          breaking: [
            {
              kind: 'removed-export',
              summary: '`foo` is no longer exported.',
              confidence: 'medium',
              evidence: [{ source: 'type-surface-diff' }],
              sites: [{ file: 'a.ts', line: 1, excerpt: 'foo()' }],
            },
          ],
        },
      ],
      /positive impact sites were found/,
    );
  });

  test('a clean verdict cannot stand on an inspection that never happened', () => {
    rejects(
      [
        {
          severity: 'clean',
          breakingCount: 0,
          impactCount: 0,
          evidenceGaps: [{ code: 'artifact-unavailable', tool: 'TypeScript declarations' }],
        },
      ],
      /says a required inspection never happened/,
    );
    rejects(
      [{ severity: 'clean', breakingCount: 0, hasCompatibilityEvidence: false }],
      /clean with no compatibility evidence/,
    );
  });
});

describe('a repeated unresolved runtime site is surfaced, not banned', () => {
  const site = { file: 'Dockerfile', line: 21, excerpt: 'FROM golang@sha256:abc', runtimeVerdict: 'unknown' };
  const runtimeCandidate = (name: string): CandidateOverrides => ({
    name,
    breaking: [{ kind: 'runtime-requirement', summary: 'needs Go 1.25', confidence: 'medium', evidence: [], sites: [site] }],
  });

  test('a wide repetition is a diagnostic, not a failure', () => {
    const many = Array.from({ length: 20 }, (_, index) => runtimeCandidate(`pkg-${index}`));
    const diagnostics = validateSemanticInvariants(recording(many), 'demo.json');
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0]!, /appears in 20 unrelated packages/);
  });

  test('a handful of genuine repeats says nothing', () => {
    const few = Array.from({ length: 3 }, (_, index) => runtimeCandidate(`pkg-${index}`));
    assert.deepEqual(validateSemanticInvariants(recording(few), 'demo.json'), []);
  });
});
