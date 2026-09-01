import assert from 'node:assert/strict';
import test from 'node:test';
import { repinRequirements, resolvedVersions } from './timemachine.ts';

test('TimeMachine repins only dependencies with an exact historical identity', () => {
  const result = repinRequirements(
    ['requests>=2.20', 'urllib3==1.26.18', 'certifi'].join('\n'),
    resolvedVersions(['requests==2.32.4', 'urllib3==2.5.0', 'certifi==2025.8.3'].join('\n')),
  );

  assert.equal(result.text, ['requests>=2.20', 'urllib3==2.5.0', 'certifi'].join('\n'));
  assert.deepEqual(result.changed, [{ name: 'urllib3', from: '1.26.18', to: '2.5.0' }]);
  assert.deepEqual(result.unresolved, [
    { name: 'requests', requirement: 'requests>=2.20', to: '2.32.4' },
    { name: 'certifi', requirement: 'certifi', to: '2025.8.3' },
  ]);
});
