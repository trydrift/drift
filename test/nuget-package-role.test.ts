import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyNugetPackage, nugetSurface } from '../dist/evidence/surface/dotnet.js';
import { clearHttpCache } from '../dist/util/http.js';
import { createLogger } from '../dist/util/logger.js';

const realFetch = globalThis.fetch;
const entry = (path: string, content = '') => ({ path, read: () => Buffer.from(content) });

function storedZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [path, content] of Object.entries(files)) {
    const name = Buffer.from(path);
    const data = Buffer.from(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, eocd]);
}

function serve(before: Buffer, after: Buffer): void {
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes('/1.0.0/')) return new Response(new Uint8Array(before));
    if (url.includes('/2.0.0/')) return new Response(new Uint8Array(after));
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

const request = (name = 'Microsoft.NET.Test.Sdk') => ({
  name,
  from: '1.0.0',
  to: '2.0.0',
  exec: async () => ({ code: 1, stdout: '', stderr: 'must not execute' }),
  workdir: '/tmp/drift-nuget-role-test',
  logger: createLogger('error'),
  timeoutMs: 10_000,
});

afterEach(() => {
  globalThis.fetch = realFetch;
  clearHttpCache();
});

describe('NuGet package roles', () => {
  test('classifies managed, analyzer, MSBuild, tool, and meta packages', () => {
    assert.equal(classifyNugetPackage([entry('ref/net8.0/Demo.dll')]), 'managed-library');
    assert.equal(classifyNugetPackage([entry('analyzers/dotnet/cs/Demo.dll')]), 'analyzer');
    assert.equal(classifyNugetPackage([entry('buildTransitive/Demo.props')]), 'msbuild');
    assert.equal(classifyNugetPackage([entry('tools/net8.0/any/tool.dll')]), 'tool');
    assert.equal(
      classifyNugetPackage([entry('Demo.nuspec', '<package><dependencies><dependency id="Core" version="1" /></dependencies></package>')]),
      'meta-package',
    );
    assert.equal(classifyNugetPackage([entry('content/readme.txt')]), 'unsupported');
  });

  test('Microsoft.NET.Test.Sdk-shaped MSBuild packages compare their build contract', async () => {
    serve(
      storedZip({ 'build/netcoreapp2.1/Microsoft.NET.Test.Sdk.props': '<Project><Old /></Project>' }),
      storedZip({ 'build/netcoreapp2.1/Microsoft.NET.Test.Sdk.props': '<Project><New /></Project>' }),
    );
    const outcome = await nugetSurface.compute(request());
    assert.equal(outcome.available, true);
    if (!outcome.available) return;
    assert.match(outcome.locator, /NuGet package roles: msbuild → msbuild/);
    assert.equal(outcome.changes[0]?.kind, 'signature-changed');
    assert.doesNotMatch(outcome.locator, /assembly metadata/);
  });

  test('analyzer and tool file removals are role-specific contract changes', async () => {
    serve(
      storedZip({ 'analyzers/dotnet/cs/A.dll': 'a', 'analyzers/dotnet/cs/B.dll': 'b' }),
      storedZip({ 'analyzers/dotnet/cs/A.dll': 'a' }),
    );
    const analyzer = await nugetSurface.compute(request('Analyzer.Package'));
    assert.equal(analyzer.available, true);
    if (analyzer.available) assert.ok(analyzer.changes.some((change) => /b\.dll/.test(change.symbol)));

    clearHttpCache();
    serve(storedZip({ 'tools/a.cmd': 'old' }), storedZip({ 'tools/a.cmd': 'new' }));
    const tool = await nugetSurface.compute(request('Tool.Package'));
    assert.equal(tool.available, true);
    if (tool.available) assert.equal(tool.changes[0]?.kind, 'signature-changed');
  });

  test('dependency-only meta-packages compare dependency metadata', async () => {
    serve(
      storedZip({ 'Meta.nuspec': '<package><dependencies><dependency id="Core" version="[1,2)" /></dependencies></package>' }),
      storedZip({ 'Meta.nuspec': '<package><dependencies><dependency id="Core" version="[2,3)" /></dependencies></package>' }),
    );
    const outcome = await nugetSurface.compute(request('Meta.Package'));
    assert.equal(outcome.available, true);
    if (!outcome.available) return;
    assert.match(outcome.locator, /meta-package → meta-package/);
    assert.equal(outcome.changes[0]?.symbol, 'nuget:meta-package:dependency:Core');
  });

  test('unclassified packages report an explicit unsupported role, never a missing DLL', async () => {
    const archive = storedZip({ 'content/readme.txt': 'hello' });
    serve(archive, archive);
    const outcome = await nugetSurface.compute(request('Content.Package'));
    assert.equal(outcome.available, false);
    if (outcome.available) return;
    assert.equal(outcome.reason, 'artifact-type-unsupported');
    assert.doesNotMatch(outcome.detail, /missing managed assembly|no managed assembly/i);
  });
});
