import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, mkdir, mkdtemp } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const run = promisify(execFile);
import { RECORDING_ENGINE_PATHS } from '../site/scripts/recording-engine-manifest.mjs';
import {
  validateAuditInvariants,
  freshRecordingNames,
} from '../site/scripts/validate-recordings.mjs';
import { engineFingerprint, analyzerEnvironmentIdentity } from '../site/scripts/engine-fingerprint.mjs';
import { RECORDING_ANALYZER_ENVIRONMENT } from '../site/scripts/analyzer-environment.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const CURRENT = await engineFingerprint(repoRoot);
const REAL = JSON.parse(await readFile(join(repoRoot, 'site/src/data/scrapy.json'), 'utf8'));

/** A clone of a real, currently-valid recording, ready to mutate per scenario. */
const clone = () => structuredClone(REAL);

describe('recording refresh triggers stay in lockstep with fingerprint inputs', () => {
  test('every RECORDING_ENGINE_PATHS entry is a refresh-recordings.yml push trigger', async () => {
    const workflow = await readFile(join(repoRoot, '.github/workflows/refresh-recordings.yml'), 'utf8');
    const triggers = [...workflow.matchAll(/^\s+- '([^']+)'\s*$/gm)].map((m) => m[1]!);
    for (const input of RECORDING_ENGINE_PATHS) {
      assert.ok(
        triggers.includes(input) || triggers.includes(`${input}/**`),
        `${input} changes the recording fingerprint but does not trigger refresh-recordings.yml`,
      );
    }
  });

  test('the engine fingerprint reads from the shared manifest, not a private copy', async () => {
    const src = await readFile(join(repoRoot, 'site/scripts/engine-fingerprint.mjs'), 'utf8');
    assert.match(src, /RECORDING_ENGINE_PATHS/);
    assert.doesNotMatch(src, /const ENGINE_PATHS\s*=/);
  });

  test('every workflow that validates recordings pins the same Python as the capture workflow', async () => {
    // The engine fingerprint folds in `python3`'s major.minor. If a job that
    // runs `validate-recordings` (directly or via the site build) does not pin
    // the same interpreter the capture workflow uses, it computes a different
    // expected fingerprint and rejects recordings another job just accepted.
    const declared = RECORDING_ANALYZER_ENVIRONMENT.python.declared;
    const pins = (yaml) => [...yaml.matchAll(/python-version:\s*'?([\d.]+)'?/g)].map((m) => m[1]);

    const refresh = await readFile(join(repoRoot, '.github/workflows/refresh-recordings.yml'), 'utf8');
    assert.ok(pins(refresh).length > 0, 'the capture workflow pins a Python version');
    for (const v of pins(refresh)) assert.equal(v, declared, 'capture workflow pins the declared Python');

    for (const wf of ['.github/workflows/ci.yml', '.github/workflows/pages.yml']) {
      const yaml = await readFile(join(repoRoot, wf), 'utf8');
      assert.ok(
        yaml.includes('setup-python'),
        `${wf} runs recording validation but never sets up Python`,
      );
      for (const v of pins(yaml)) {
        assert.equal(v, declared, `${wf} pins Python ${v}, not the declared ${declared}`);
      }
    }
  });
});

describe('recording freshness: what must carry the current engine fingerprint', () => {
  test('a recording this run produced or changed must carry the current fingerprint', () => {
    const changed = { ...clone(), engine: 'a-previous-fingerprint' };
    assert.throws(
      () => validateAuditInvariants(changed, 'scrapy.json', true, CURRENT),
      /stale engine fingerprint/,
    );
  });

  test('freshRecordingNames picks up a newly created, untracked recording', async () => {
    // Built in a throwaway git repo, never under the real `site/src/data`: an
    // earlier version wrote `site/src/data/__freshness_probe__.json` into this
    // very checkout, and under a parallel test run `real-repo-recordings.test.ts`
    // would glob that `{}` file as if it were a recording and crash on
    // `recording.candidates`. An isolated fixture repo cannot be observed by any
    // other suite, so the result no longer depends on test execution order.
    const fixture = await mkdtemp(join(tmpdir(), 'drift-freshness-'));
    try {
      await run('git', ['init', '-q'], { cwd: fixture });
      await mkdir(join(fixture, 'site/src/data'), { recursive: true });
      await writeFile(join(fixture, 'site/src/data/tracked.json'), '{}\n');
      await run('git', ['add', '.'], { cwd: fixture });
      await run('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'seed'], {
        cwd: fixture,
      });

      // A brand-new, never-tracked recording: `git status --porcelain` reports
      // it as untracked, so `freshRecordingNames` must include it.
      await writeFile(join(fixture, 'site/src/data/__freshness_probe__.json'), '{}\n');
      const fresh = await freshRecordingNames(fixture);
      assert.ok(
        fresh.has('__freshness_probe__.json'),
        'an untracked file under site/src/data is "produced by this run" and must be checked',
      );
      assert.ok(
        !fresh.has('tracked.json'),
        'an unchanged committed recording is not "produced by this run"',
      );
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  test('a current recording that violates a current-engine semantic invariant is rejected', () => {
    const bad = clone();
    for (const entry of bad.candidates) {
      entry.publishedVersions = [entry.selected];
      entry.provenance = { kind: 'runtime', source: 'manifest' };
    }
    // `unknown` runtime compatibility may never be recorded as `upstream-only`.
    const candidate = bad.candidates.find((entry) => (entry.runtimeAnalyses?.length ?? 0) > 0);
    assert.ok(candidate, 'fixture must contain a runtime-analyzed candidate');
    candidate.runtimeCompatibility = 'unknown';
    candidate.recommendation = 'upgrade-after-review';
    candidate.severity = 'upstream-only';
    for (const analysis of candidate.runtimeAnalyses) {
      analysis.state = 'unknown';
      analysis.reason = 'no-declaration';
      analysis.siteCount = 0;
      analysis.declarationCount = 0;
      analysis.unresolvedCount = 0;
    }
    assert.throws(
      () => validateAuditInvariants(bad, 'scrapy.json', true, bad.engine),
      /severity upstream-only|bijection/,
    );
  });
});

describe('recording freshness: what --allow-stale legitimately keeps alive', () => {
  test('an unchanged stale recording passes when it is only out of date', () => {
    const stale = { ...clone(), engine: 'an-older-fingerprint' };
    assert.doesNotThrow(() => validateAuditInvariants(stale, 'scrapy.json', false, CURRENT));
  });

  test('a stale recording is still rejected when it is structurally malformed', () => {
    const broken = clone();
    broken.engine = 'an-older-fingerprint';
    const candidate = broken.candidates[0];
    candidate.breaking = [
      {
        kind: 'runtime-requirement',
        runtime: { kind: 'minimum-runtime', runtime: 'node', requirement: 'not-a-version' },
      },
    ];
    assert.throws(
      () => validateAuditInvariants(broken, 'scrapy.json', false, CURRENT),
      /malformed runtime requirement/,
    );
  });

  test('a stale recording missing a current-only field is not rejected for that alone', () => {
    const old = clone();
    old.engine = 'an-older-fingerprint';
    // Fields the current capture emits that a pre-#100 recording would lack.
    for (const candidate of old.candidates) {
      delete candidate.runtimeAnalyses;
      delete candidate.dispositions;
      delete candidate.runtimeChanges;
      delete candidate.independentActionableFindingCount;
      delete candidate.hasCompatibilityEvidence;
    }
    assert.doesNotThrow(
      () => validateAuditInvariants(old, 'scrapy.json', false, CURRENT),
      'a retained stale recording predates these invariants and must survive without them',
    );
    // The same recording judged as current would be rejected — the invariants
    // are still enforced, just not on artifacts that predate them.
    assert.throws(() => validateAuditInvariants(old, 'scrapy.json', true, CURRENT));
  });
});

describe('recording validator: `||` runtime disjunctions', () => {
  // A stale engine fingerprint keeps these on Layer A (baseline artifact
  // validity) only — the layer that owns both the requirement-shape check and
  // the "compatible pin reported as an impact" tripwire — without needing the
  // full current-engine analysis fields.
  const layerA = (runtime: Record<string, unknown>, sites: unknown[] = []) => {
    const recording = clone();
    recording.engine = 'an-older-fingerprint';
    recording.candidates = [recording.candidates[0]];
    recording.candidates[0].breaking = [{ id: 'rt', kind: 'runtime-requirement', runtime, sites }];
    return recording;
  };

  test('a disjunction of valid branches is accepted as a structured requirement', () => {
    const recording = layerA({
      kind: 'minimum-runtime',
      runtime: 'node',
      requirement: '^18.14.0 || ^20.0.0 || ^22.0.0 || >=24.0.0',
    });
    assert.doesNotThrow(() => validateAuditInvariants(recording, 'scrapy.json', false, CURRENT));
  });

  test('a disjunction with one malformed branch is still rejected', () => {
    const recording = layerA({
      kind: 'minimum-runtime',
      runtime: 'node',
      requirement: '^18.14.0 || not-a-version',
    });
    assert.throws(
      () => validateAuditInvariants(recording, 'scrapy.json', false, CURRENT),
      /malformed runtime requirement/,
    );
  });

  test('the tripwire still fires when a pin satisfying one branch is reported as an impact', () => {
    // The exact class of bug this check caught for GitLab: `.nvmrc = 22.12.0`
    // satisfies the `^22.0.0` branch, so an impact site on it is wrong.
    const recording = layerA(
      { kind: 'minimum-runtime', runtime: 'node', requirement: '^18.14.0 || ^20.0.0 || ^22.0.0 || >=24.0.0' },
      [{ file: '.nvmrc', line: 1, excerpt: '22.12.0', matchedSymbol: 'node', confidence: 'high', runtimeVerdict: 'incompatible' }],
    );
    assert.throws(
      () => validateAuditInvariants(recording, 'scrapy.json', false, CURRENT),
      /compatible node declaration was reported as an impact/,
    );
  });

  test('a pin outside every branch is a legitimate impact site and does not trip the wire', () => {
    const recording = layerA(
      { kind: 'minimum-runtime', runtime: 'node', requirement: '^22.13.0 || ^24.0.0 || >=26.0.0' },
      [{ file: '.nvmrc', line: 1, excerpt: '22.12.0', matchedSymbol: 'node', confidence: 'high', runtimeVerdict: 'incompatible' }],
    );
    assert.doesNotThrow(() => validateAuditInvariants(recording, 'scrapy.json', false, CURRENT));
  });
});

/**
 * #138: the recording engine fingerprint's analyzer-environment identity must
 * treat two Python patch releases as equivalent, two different minor
 * releases as materially different, and a missing interpreter as an
 * explicit failure — never a shared "unavailable" placeholder every broken
 * environment could collide on. See `analyzer-environment.mjs` for the
 * documented contract.
 */
describe('#138: analyzer environment identity is normalized, reproducible, and fails loudly when absent', () => {
  const okCommand = (output: string) => async () => ({ stdout: output, stderr: '' });
  const manifest = { python: RECORDING_ANALYZER_ENVIRONMENT.python };

  test('two different Python patch releases normalize to the same identity', async () => {
    const local = await analyzerEnvironmentIdentity(manifest, okCommand('Python 3.12.3\n'));
    const ci = await analyzerEnvironmentIdentity(manifest, okCommand('Python 3.12.9\n'));
    assert.deepEqual(local, ci);
    assert.deepEqual(local, ['python=3.12']);
  });

  test('a materially different Python minor version normalizes to a different identity', async () => {
    const py312 = await analyzerEnvironmentIdentity(manifest, okCommand('Python 3.12.3\n'));
    const py311 = await analyzerEnvironmentIdentity(manifest, okCommand('Python 3.11.9\n'));
    assert.notDeepEqual(py312, py311);
  });

  test('a locally-captured recording under the intended analyzer environment matches CI’s engine identity', async () => {
    // Local and CI both pin Python 3.12 (see .github/workflows/refresh-recordings.yml
    // and RECORDING_ANALYZER_ENVIRONMENT.python.declared) but can legitimately run
    // different patch releases of it; the fingerprint they contribute to must agree.
    const local = await analyzerEnvironmentIdentity(manifest, okCommand('Python 3.12.1\n'));
    const ci = await analyzerEnvironmentIdentity(manifest, okCommand('Python 3.12.8\n'));
    assert.deepEqual(local, ci);
  });

  test('a missing required analyzer fails explicitly rather than becoming a reusable "unavailable" identity', async () => {
    const missing = async () => {
      throw new Error('spawn python3 ENOENT');
    };
    await assert.rejects(() => analyzerEnvironmentIdentity(manifest, missing), /requires `python3`/);
  });

  test('output the normalizer cannot parse fails explicitly rather than silently omitting the tool', async () => {
    await assert.rejects(
      () => analyzerEnvironmentIdentity(manifest, okCommand('not a version string')),
      /Could not read a python version/,
    );
  });

  test('the normalizer itself: major.minor only, patch and build metadata dropped', () => {
    assert.equal(RECORDING_ANALYZER_ENVIRONMENT.python.normalize('Python 3.12.7'), '3.12');
    assert.equal(RECORDING_ANALYZER_ENVIRONMENT.python.normalize('Python 3.12.0rc1'), '3.12');
    assert.equal(RECORDING_ANALYZER_ENVIRONMENT.python.normalize('not a version'), null);
  });
});
