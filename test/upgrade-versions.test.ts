import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { lookupVersions } from '../dist/upgrade/versions.js';
import { scanTitle } from '../dist/upgrade/severity.js';
import { clearHttpCache } from '../dist/util/http.js';

/**
 * "Unknown must never become safe."
 *
 * The scanner used to collapse three different answers into one: a registry
 * that said "nothing newer", a registry that did not answer, and an ecosystem
 * with no version API at all. All three came back as `null` and all three were
 * reported as **Up to date** — so a timeout, a malformed body, and every Swift
 * and opam dependency in the repository read as a clean bill of health.
 *
 * These tests exist to make that specific regression impossible to reintroduce
 * quietly. Every one of them is about the *difference* between "checked and
 * current" and "never checked".
 */

const realFetch = globalThis.fetch;

/** Answer every request with one canned response, whatever the URL. */
function stubFetch(responder: (url: string) => Response | Promise<Response>): void {
  clearHttpCache();
  globalThis.fetch = ((input: string | URL | Request) =>
    Promise.resolve(responder(String(input)))) as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  globalThis.fetch = realFetch;
  clearHttpCache();
});

describe('version lookup: the three honest outcomes', () => {
  test('a registry that answers with nothing newer is up-to-date', async () => {
    stubFetch(() => json({ 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {} } }));

    const result = await lookupVersions({
      name: 'left-pad',
      ecosystem: 'npm',
      current: '1.0.0',
      range: '^1.0.0',
    });

    assert.equal(result.outcome, 'up-to-date');
  });

  test('a registry that answers with a newer version is an upgrade', async () => {
    stubFetch(() =>
      json({ 'dist-tags': { latest: '2.0.0' }, versions: { '1.0.0': {}, '1.5.0': {}, '2.0.0': {} } }),
    );

    const result = await lookupVersions({
      name: 'left-pad',
      ecosystem: 'npm',
      current: '1.0.0',
      range: '^1.0.0',
    });

    assert.equal(result.outcome, 'upgrade');
    if (result.outcome !== 'upgrade') return;
    assert.equal(result.latest, '2.0.0');
    // Bounded by the declared range, so the safe landing stays on 1.x.
    assert.equal(result.safeLatest, '1.5.0');
  });

  test('an unreachable registry is unchecked, NOT up to date', async () => {
    stubFetch(() => {
      throw new Error('ECONNRESET');
    });

    const result = await lookupVersions({
      name: 'left-pad',
      ecosystem: 'npm',
      current: '1.0.0',
      range: '^1.0.0',
    });

    assert.equal(result.outcome, 'unchecked');
    assert.notEqual(result.outcome, 'up-to-date');
    if (result.outcome !== 'unchecked') return;
    assert.match(result.reason, /could not reach the npm registry/i);
  });

  test('a 500 from the registry is unchecked', async () => {
    stubFetch(() => new Response('upstream exploded', { status: 500 }));

    const result = await lookupVersions({
      name: 'requests',
      ecosystem: 'pypi',
      current: '2.0.0',
      range: '>=2.0.0',
    });

    assert.equal(result.outcome, 'unchecked');
  });

  test('a malformed registry body is unchecked, not an empty release history', async () => {
    stubFetch(() => new Response('<html>not json</html>', { status: 200 }));

    const result = await lookupVersions({
      name: 'left-pad',
      ecosystem: 'npm',
      current: '1.0.0',
      range: '^1.0.0',
    });

    assert.equal(result.outcome, 'unchecked');
  });

  test('version numbers Drift cannot parse are unchecked, not current', async () => {
    stubFetch(() => json({ versions: { 'not-a-version': {}, 'also-nonsense': {} } }));

    const result = await lookupVersions({
      name: 'weird',
      ecosystem: 'npm',
      current: '1.0.0',
      range: '^1.0.0',
    });

    assert.equal(result.outcome, 'unchecked');
    if (result.outcome !== 'unchecked') return;
    assert.match(result.reason, /could not read/i);
  });

  test('an installed version that is not comparable is unchecked', async () => {
    // A git SHA, a `file:` link, a distro-patched string — nothing semver can
    // order, so no comparison against published versions means anything.
    const result = await lookupVersions({
      name: 'vendored',
      ecosystem: 'npm',
      current: 'abc1234',
      range: '*',
    });

    assert.equal(result.outcome, 'unchecked');
    if (result.outcome !== 'unchecked') return;
    assert.match(result.reason, /cannot compare/i);
  });
});

/**
 * Swift and opam are the ecosystems the old code was silently wrong about:
 * `fetchRegistryInfo` returns an empty version list for Swift (versions are
 * git tags) and null for opam (no JSON API), so every dependency in both
 * reported "up to date" without a single lookup ever happening.
 */
describe('version lookup: ecosystems with no package registry', () => {
  test('Swift versions come from the git tags, not an empty registry record', async () => {
    stubFetch((url) => {
      assert.match(url, /api\.github\.com\/repos\/apple\/swift-nio\/tags/);
      return json([{ name: '2.60.0' }, { name: '2.62.0' }, { name: '2.75.0' }]);
    });

    const result = await lookupVersions({
      name: 'apple/swift-nio',
      ecosystem: 'swift',
      current: '2.60.0',
      range: '2.60.0',
    });

    assert.equal(result.outcome, 'upgrade');
    if (result.outcome !== 'upgrade') return;
    assert.equal(result.latest, '2.75.0');
  });

  test('a Swift package whose tags cannot be listed is unchecked, not up to date', async () => {
    stubFetch(() => new Response('', { status: 404 }));

    const result = await lookupVersions({
      name: 'apple/swift-nio',
      ecosystem: 'swift',
      current: '2.60.0',
      range: '2.60.0',
    });

    assert.equal(result.outcome, 'unchecked');
    if (result.outcome !== 'unchecked') return;
    assert.match(result.reason, /git tags/i);
  });

  test('opam versions come from the opam repository package directories', async () => {
    stubFetch((url) => {
      assert.match(url, /ocaml\/opam-repository\/contents\/packages\/lwt/);
      return json([
        { name: 'lwt.5.6.1', type: 'dir' },
        { name: 'lwt.5.7.0', type: 'dir' },
        // Not a release directory; must not become a version.
        { name: 'README.md', type: 'file' },
      ]);
    });

    const result = await lookupVersions({
      name: 'lwt',
      ecosystem: 'opam',
      current: '5.6.1',
      range: '>= 5.6.1',
    });

    assert.equal(result.outcome, 'upgrade');
    if (result.outcome !== 'upgrade') return;
    assert.equal(result.latest, '5.7.0');
  });

  test('an opam package the repository cannot be listed for is unchecked', async () => {
    stubFetch(() => new Response('', { status: 403 }));

    const result = await lookupVersions({
      name: 'lwt',
      ecosystem: 'opam',
      current: '5.6.1',
      range: '>= 5.6.1',
    });

    assert.equal(result.outcome, 'unchecked');
    if (result.outcome !== 'unchecked') return;
    assert.match(result.reason, /opam repository/i);
  });
});

describe('scan title: a run that could not check something never claims it did', () => {
  test('unchecked dependencies are never folded into the up-to-date count', () => {
    // 47 checked, 4 of which never got a lookup. The old title for this was
    // "Scan — 47 up to date".
    assert.equal(scanTitle([], 47, 4), 'Scan — 43 up to date, 4 could not be checked');
  });

  test('a run where nothing could be checked says exactly that', () => {
    assert.equal(scanTitle([], 4, 4), 'Scan — 4 could not be checked');
  });

  test('a genuinely clean run still reads clean', () => {
    assert.equal(scanTitle([], 47, 0), 'Scan — 47 up to date');
  });

  test('unlooked dependencies keep a candidate list from being titled "all safe"', () => {
    const safe = { status: 'clean', breakingCount: 0, impactCount: 0, impactFiles: 0, recommendation: 'safe' };
    assert.match(scanTitle([safe], 10, 2), /unverified/);
    assert.match(scanTitle([safe], 10, 0), /all safe/);
  });
});
