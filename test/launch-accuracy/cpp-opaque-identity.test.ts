import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectChanges, triage } from '../../dist/detect/index.js';
import { parsePublishedVersion, comparePackageVersions, classifyPackageBump, satisfiesPackageRange } from '../../dist/version-semantics.js';
import { DriftConfigSchema } from '../../dist/config/schema.js';
import { ECOSYSTEM_CAPABILITIES } from '../../dist/detect/capabilities.js';

/**
 * Drift knows exactly which artifact `fmt/10.2.1` is. It does not know whether
 * that is newer than `fmt/9.1.0` — Conan and vcpkg let each recipe pick its own
 * version scheme, and there is no ordering that is right across all of them.
 *
 * Those are two different facts, and the second was silently deciding the
 * first. Refusing to parse an exact literal version made every C/C++ change
 * fail triage with *"target manifest range has no exact resolved registry
 * version"* — so the header surface provider, which Drift advertises, could
 * never run on the one ecosystem it exists for.
 */

const config = DriftConfigSchema.parse({
  ecosystems: ['conan', 'vcpkg'],
  triggerOn: { major: true, minor: true, patch: true, dev: true, transitive: true },
});

describe('opaque exact identity for Conan and vcpkg', () => {
  test('an exact literal version is an identity', () => {
    for (const [ecosystem, raw] of [
      ['conan', '9.1.0'],
      ['conan', '10.2.1'],
      ['conan', 'cci.20210324'],
      ['vcpkg', '2023-01-25'],
      ['vcpkg', '1.2.3#1'],
    ] as const) {
      const parsed = parsePublishedVersion(raw, ecosystem);
      assert.equal(parsed?.raw, raw, raw);
      assert.equal(parsed?.release, null, 'no release tuple is invented');
      assert.equal(parsed?.prerelease, false, 'no prerelease classification is invented');
    }
  });

  test('equality is provable; ordering is unknown', () => {
    assert.equal(comparePackageVersions('10.2.1', '10.2.1', 'conan'), 0);
    assert.equal(comparePackageVersions('9.1.0', '10.2.1', 'conan'), null);
    assert.equal(comparePackageVersions('10.2.1', '9.1.0', 'conan'), null);
  });

  test('bump classification and range satisfaction stay unknown', () => {
    assert.equal(classifyPackageBump('9.1.0', '10.2.1', 'conan'), 'unknown');
    assert.equal(satisfiesPackageRange('10.2.1', '10.2.1', 'conan'), true);
    assert.equal(satisfiesPackageRange('10.2.1', '>=9.0.0', 'conan'), null);
  });

  test('a constraint is not an identity and still fails closed', () => {
    for (const [ecosystem, raw] of [
      ['conan', '[>=1.0 <2.0]'],
      ['conan', '*'],
      ['vcpkg', '>=1.0'],
      ['vcpkg', ''],
    ] as const) {
      assert.equal(parsePublishedVersion(raw, ecosystem), null, `${ecosystem} ${raw}`);
    }
  });
});

describe('a declared C/C++ version change reaches analysis', () => {
  test('fmt/9.1.0 -> fmt/10.2.1 is actionable, not skipped', () => {
    const changes = detectChanges([
      {
        path: 'conanfile.txt',
        before: '[requires]\nfmt/9.1.0\n',
        after: '[requires]\nfmt/10.2.1\n',
      },
    ]);

    assert.deepEqual(
      changes.map((change) => [change.name, change.from, change.to, change.bump]),
      [['fmt', '9.1.0', '10.2.1', 'unknown']],
    );

    const { actionable, skipped } = triage(changes, config);
    assert.deepEqual(
      skipped.map((entry) => entry.reason),
      [],
      'a change with two exact identities must not be skipped for lacking one',
    );
    assert.equal(actionable.length, 1);
  });

  test('a vcpkg override change is actionable too', () => {
    const changes = detectChanges([
      {
        path: 'vcpkg.json',
        before: JSON.stringify({ dependencies: ['fmt'], overrides: [{ name: 'fmt', version: '9.1.0' }] }),
        after: JSON.stringify({ dependencies: ['fmt'], overrides: [{ name: 'fmt', version: '10.2.1' }] }),
      },
    ]);

    const fmt = changes.find((change) => change.name === 'fmt');
    assert.equal(fmt?.from, '9.1.0');
    assert.equal(fmt?.to, '10.2.1');
    assert.deepEqual(triage(changes, config).skipped, []);
  });

  test('the same version written twice is not a change', () => {
    const manifest = '[requires]\nfmt/10.2.1\n';
    assert.deepEqual(detectChanges([{ path: 'conanfile.txt', before: manifest, after: manifest }]), []);
  });
});

describe('advertised capabilities match reachable behaviour', () => {
  test('Conan and vcpkg no longer claim full upgrade discovery', () => {
    // Drift cannot order these versions, so it cannot discover an upgrade.
    // The claim is downgraded rather than the behaviour faked.
    for (const ecosystem of ['conan', 'vcpkg'] as const) {
      const capability = ECOSYSTEM_CAPABILITIES.find((entry) => entry.ecosystem === ecosystem)!;
      assert.equal(capability.support['upgrade-discovery'].level, 'partial', ecosystem);
      assert.match(capability.support['upgrade-discovery'].note ?? '', /ordering|newest/i);
    }
  });

  test('the C/C++ surface capability is still claimed, and is now reachable', () => {
    for (const ecosystem of ['conan', 'vcpkg'] as const) {
      const capability = ECOSYSTEM_CAPABILITIES.find((entry) => entry.ecosystem === ecosystem)!;
      assert.notEqual(capability.support.surface.level, 'unsupported', ecosystem);
    }
  });
});
