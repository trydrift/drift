import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyNuGetRoles,
  describeRole,
  nugetContractFiles,
} from '../../dist/evidence/surface/package-roles.js';

/**
 * `Microsoft.NET.Test.Sdk` ships MSBuild props and targets, not a managed
 * assembly, and never has. Reporting its runtime DLL as unexpectedly missing
 * described Drift's expectation, not the package.
 */

describe('NuGet package roles', () => {
  test('a test SDK is build tooling, not a package missing its assembly', () => {
    const paths = [
      'Microsoft.NET.Test.Sdk.nuspec',
      'build/netcoreapp3.1/Microsoft.NET.Test.Sdk.props',
      'build/netcoreapp3.1/Microsoft.NET.Test.Sdk.targets',
      'buildTransitive/netcoreapp3.1/Microsoft.NET.Test.Sdk.props',
      '[Content_Types].xml',
    ];
    const roles = classifyNuGetRoles(paths);

    assert.equal(roles.has('build-tooling'), true);
    assert.equal(roles.has('library'), false);
    assert.equal(describeRole('build-tooling'), 'a build-tooling package');
    assert.deepEqual(nugetContractFiles(paths), [
      'build/netcoreapp3.1/Microsoft.NET.Test.Sdk.props',
      'build/netcoreapp3.1/Microsoft.NET.Test.Sdk.targets',
      'buildTransitive/netcoreapp3.1/Microsoft.NET.Test.Sdk.props',
    ]);
  });

  test('every role is told apart', () => {
    assert.equal(classifyNuGetRoles(['lib/net8.0/Demo.dll']).has('library'), true);
    assert.equal(classifyNuGetRoles(['ref/net8.0/Demo.dll']).has('library'), true);
    assert.equal(classifyNuGetRoles(['analyzers/dotnet/cs/Demo.dll']).has('analyzer'), true);
    assert.equal(classifyNuGetRoles(['tools/net8.0/any/demo.exe']).has('tool'), true);
    assert.deepEqual([...classifyNuGetRoles(['Demo.nuspec'])], ['meta-package']);
  });
});
