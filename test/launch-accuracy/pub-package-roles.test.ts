import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPubPackage,
  diffPubContracts,
  parsePubspecContract,
} from '../../dist/evidence/surface/package-roles.js';

/**
 * `cupertino_icons` is a font bundle. It publishes no meaningful Dart API by
 * design, so "no Dart API found" is a description of its role rather than a
 * failed inspection.
 */

describe('pub package roles', () => {
  const CUPERTINO_ICONS = `name: cupertino_icons
version: 1.0.8
description: Default icons asset for Cupertino widgets.
environment:
  sdk: '>=2.12.0 <4.0.0'
flutter:
  fonts:
    - family: CupertinoIcons
      fonts:
        - asset: assets/CupertinoIcons.ttf
`;

  test('a font bundle is classified as an asset package', () => {
    const contract = classifyPubPackage(
      ['pubspec.yaml', 'assets/CupertinoIcons.ttf', 'lib/cupertino_icons.dart'],
      CUPERTINO_ICONS,
      false,
    );

    assert.equal(contract.role, 'assets');
    assert.deepEqual([...contract.fonts.keys()], ['CupertinoIcons']);
    assert.deepEqual(contract.fonts.get('CupertinoIcons'), ['assets/CupertinoIcons.ttf']);
  });

  test('a package with a real Dart API is a library whatever else it ships', () => {
    const contract = classifyPubPackage(['pubspec.yaml', 'lib/demo.dart'], CUPERTINO_ICONS, true);
    assert.equal(contract.role, 'library');
  });

  test('executables and declared assets are read', () => {
    const declared = parsePubspecContract(`name: demo
executables:
  demo:
  other: other_main
flutter:
  assets:
    - assets/logo.png
    - assets/data/
`);
    assert.deepEqual(declared.executables, ['demo', 'other']);
    assert.deepEqual(declared.assets, ['assets/logo.png', 'assets/data/']);
  });

  test('a removed font family is a real, provable break', () => {
    const before = classifyPubPackage(['pubspec.yaml'], CUPERTINO_ICONS, false);
    const after = classifyPubPackage(
      ['pubspec.yaml'],
      CUPERTINO_ICONS.replace('CupertinoIcons\n', 'CupertinoIconsV2\n'),
      false,
    );

    const changes = diffPubContracts(before, after);
    assert.deepEqual(changes.map((change) => change.symbol), ['CupertinoIcons']);
  });

  test('an unchanged asset contract yields no invented findings', () => {
    const contract = classifyPubPackage(['pubspec.yaml'], CUPERTINO_ICONS, false);
    assert.deepEqual(diffPubContracts(contract, contract), []);
  });
});
