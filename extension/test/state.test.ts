import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DriftState } from '../src/state.js';
import type { RemediationPlan } from '../../src/types.js';

/**
 * Switching the active root in a multi-root workspace must not leave a plan,
 * status, or dependency scan attached to state that was produced for a
 * different repository — otherwise a later "Fix All" can apply one
 * repository's plan (file scopes, commit units, everything) inside another.
 */
describe('DriftState root switching', () => {
  function plan(): RemediationPlan {
    return { headSha: 'deadbeef', impactSites: [] } as unknown as RemediationPlan;
  }

  test('switching the active root clears a plan carried by the previous one', () => {
    const state = new DriftState();
    state.setRoots([
      { path: '/repo-a', label: 'repo-a', repo: null, gitRoot: null, subprojects: [] },
      { path: '/repo-b', label: 'repo-b', repo: null, gitRoot: null, subprojects: [] },
    ]);
    state.setActiveRoot('/repo-a');
    state.set({ kind: 'findings', plan: plan(), at: Date.now() });
    assert.ok(state.plan);

    state.setActiveRoot('/repo-b');

    assert.equal(state.plan, null);
    assert.equal(state.status.kind, 'idle');
  });

  test('switching the active root clears dependency scan candidates from the previous one', () => {
    const state = new DriftState();
    state.setRoots([
      { path: '/repo-a', label: 'repo-a', repo: null, gitRoot: null, subprojects: [] },
      { path: '/repo-b', label: 'repo-b', repo: null, gitRoot: null, subprojects: [] },
    ]);
    state.setActiveRoot('/repo-a');
    state.setCandidates([{ id: 'react' } as never]);
    assert.equal(state.candidates.length, 1);

    state.setActiveRoot('/repo-b');

    assert.equal(state.candidates.length, 0);
  });

  test('switching to the already-active root is a no-op, not a reset', () => {
    const state = new DriftState();
    state.setRoots([{ path: '/repo-a', label: 'repo-a', repo: null, gitRoot: null, subprojects: [] }]);
    state.setActiveRoot('/repo-a');
    state.set({ kind: 'findings', plan: plan(), at: Date.now() });

    state.setActiveRoot('/repo-a');

    assert.ok(state.plan);
  });
});
