import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { accountForRuntimeConfigCoverage } from '../dist/upgrade/scan.js';

const analysis = (state: 'compatible' | 'incompatible' | 'partial' | 'unknown') => ({
  changeId: 'runtime',
  requirement: '>=20',
  runtime: 'node' as const,
  state,
  reason: state === 'compatible' ? 'satisfies' as const : state === 'incompatible' ? 'violates' as const : state === 'partial' ? 'overlaps' as const : 'no-declaration' as const,
  declarations: [],
  unresolved: [],
  sites: [],
  statement: `${state} statement.`,
});

describe('incomplete authoritative runtime-config coverage', () => {
  test('cannot produce a confident compatible or no-declaration conclusion', () => {
    for (const state of ['compatible', 'unknown'] as const) {
      const [result] = accountForRuntimeConfigCoverage([analysis(state)], false);
      assert.equal(result?.state, 'unknown');
      assert.equal(result?.reason, 'config-incomplete');
      assert.match(result?.statement ?? '', /could not index every authoritative runtime configuration file/);
    }
  });

  test('preserves positive incompatible and partial facts', () => {
    for (const state of ['incompatible', 'partial'] as const) {
      const original = analysis(state);
      assert.equal(accountForRuntimeConfigCoverage([original], false)[0], original);
    }
  });
});
