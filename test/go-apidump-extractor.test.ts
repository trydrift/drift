import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GO_APIDUMP_SOURCE } from '../dist/evidence/surface/go-apidump.js';
import { parseGoApiDump, diffGoApi, type GoApi } from '../dist/evidence/surface/go-api.js';

/**
 * End-to-end coverage for the Go extractor itself, as opposed to `diffGoApi`
 * against hand-written JSON.
 *
 * This is the one place a bug in `GO_APIDUMP_SOURCE`'s own AST walk — as
 * opposed to a bug in how Drift interprets its output — would be caught. It
 * needs a real `go` toolchain, which this repository's own CI does not
 * install for itself (only for the example workflows it ships to users), so
 * it degrades to a stated skip rather than a failure when `go` is absent.
 */

function goAvailable(): boolean {
  try {
    execFileSync('go', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const hasGo = goAvailable();

describe('Go extractor: const/iota inheritance', { skip: hasGo ? false : 'go toolchain not installed' }, () => {
  let dir: string;
  let binary: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'drift-apidump-test-'));
    writeFileSync(join(dir, 'go.mod'), 'module driftapidumptest\n\ngo 1.21\n', 'utf8');
    writeFileSync(join(dir, 'apidump.go'), GO_APIDUMP_SOURCE, 'utf8');
    binary = join(dir, 'apidump-check');
    execFileSync('go', ['build', '-o', binary, '.'], { cwd: dir, timeout: 120_000 });
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function extract(pkgDir: string): GoApi {
    const stdout = execFileSync(
      binary,
      ['-dir', pkgDir, '-module', 'example.com/wailslike', '-platforms', 'linux/amd64'],
      { encoding: 'utf8' },
    );
    const api = parseGoApiDump(stdout);
    assert.ok(api, 'the extractor should produce parseable output');
    return api!;
  }

  function writePackage(name: string, source: string): string {
    const pkgDir = join(dir, name);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'policy.go'), source, 'utf8');
    return pkgDir;
  }

  // The shape of the actual wails v2.12 -> v2.13 regression: every constant
  // in the block explicitly repeats its type and `= iota`.
  const explicit = `package linux

type WebviewGpuPolicy int

const (
	WebviewGpuPolicyAlways   WebviewGpuPolicy = iota
	WebviewGpuPolicyOnDemand WebviewGpuPolicy = iota
	WebviewGpuPolicyNever    WebviewGpuPolicy = iota
)
`;

  // The same declarations, written the idiomatic way: only the first spec is
  // explicit, and the rest are implicit repetitions. No constant's effective
  // value changed.
  const implicitSameOrder = `package linux

type WebviewGpuPolicy int

const (
	WebviewGpuPolicyAlways WebviewGpuPolicy = iota
	WebviewGpuPolicyOnDemand
	WebviewGpuPolicyNever
)
`;

  // A real edit: two constants swapped position, so their effective values
  // really did change.
  const implicitReordered = `package linux

type WebviewGpuPolicy int

const (
	WebviewGpuPolicyOnDemand WebviewGpuPolicy = iota
	WebviewGpuPolicyAlways
	WebviewGpuPolicyNever
)
`;

  test('rewriting an iota block from explicit to implicit repetition is not a breaking change', () => {
    const before = extract(writePackage('explicit', explicit));
    const afterSameOrder = extract(writePackage('implicit-same-order', implicitSameOrder));

    const { changes } = diffGoApi(before, afterSameOrder);
    assert.deepEqual(changes, []);
  });

  test('reordering the constants in the block is a real constant-value-changed finding', () => {
    const before = extract(writePackage('explicit-2', explicit));
    const reordered = extract(writePackage('implicit-reordered', implicitReordered));

    const { changes } = diffGoApi(before, reordered);

    // Only the two constants that actually moved, and neither read as a
    // generic "signature changed" — the previous behaviour, which produced
    // nonsense "update argument order/count" remediation for a constant.
    assert.deepEqual(
      changes.map((c) => c.symbol).sort(),
      ['linux.WebviewGpuPolicyAlways', 'linux.WebviewGpuPolicyOnDemand'],
    );
    for (const change of changes) {
      assert.equal(change.kind, 'constant-value-changed');
      assert.match(change.detail, /changed value/);
    }
    assert.equal(changes.some((c) => c.symbol === 'linux.WebviewGpuPolicyNever'), false);
  });
});
