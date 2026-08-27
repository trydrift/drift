import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RECORDING_ENGINE_PATHS } from '../site/scripts/recording-engine-manifest.mjs';
import {
  validateAuditInvariants,
  freshRecordingNames,
} from '../site/scripts/validate-recordings.mjs';
import { engineFingerprint } from '../site/scripts/engine-fingerprint.mjs';

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
    const probe = join(repoRoot, 'site/src/data/__freshness_probe__.json');
    await writeFile(probe, '{}\n');
    try {
      const fresh = await freshRecordingNames(repoRoot);
      assert.ok(
        fresh.has('__freshness_probe__.json'),
        'an untracked file under site/src/data is "produced by this run" and must be checked',
      );
    } finally {
      await rm(probe, { force: true });
    }
  });

  test('a current recording that violates a current-engine semantic invariant is rejected', () => {
    const bad = clone();
    // `unknown` runtime compatibility may never be recorded as `upstream-only`.
    for (const candidate of bad.candidates) {
      if (candidate.runtimeCompatibility === 'unknown') candidate.severity = 'upstream-only';
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
