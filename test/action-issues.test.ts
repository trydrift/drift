import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createIssuesForFindings } from '../dist/runners/action.js';
import { DEFAULT_CONFIG } from '../dist/config/schema.js';
import { createLogger } from '../dist/util/logger.js';

/**
 * `createIssuesForFindings` reconciles what a rescan finds against what is
 * already open: it updates an issue whose evidence changed, and closes one
 * whose finding no longer reproduces. Both are new behaviour — the original
 * only ever created and deduplicated — so both get their own coverage here,
 * along with the category scoping that keeps the push-triggered pipeline
 * from closing issues the scheduled outdated scan opened, and back.
 */

const logger = createLogger('error');
const repo = { owner: 'acme', repo: 'widgets', afterSha: 'deadbeef', baseBranch: 'main' };
const config = { ...DEFAULT_CONFIG, codeScanning: { ...DEFAULT_CONFIG.codeScanning, createIssuesPerAlert: true } };

function finding(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ruleId: 'drift/npm/zod',
    ruleName: 'zod 3 → 4',
    dependency: 'zod',
    ecosystem: 'npm',
    dependencyKind: 'runtime',
    from: '3.0.0',
    to: '4.0.0',
    manifestPath: 'package.json',
    level: 'warning',
    message: 'zod 3 → 4 breaks a call site.',
    primaryLocation: { file: 'src/a.ts', line: 1 },
    relatedLocations: [],
    snippetOk: false,
    ...overrides,
  } as never;
}

/** A duck-typed stand-in for `GitHubClient`, recording every call it gets. */
function mockGithub(opts: {
  openByMarker?: Record<string, number>;
  issueBodies?: Record<number, string>;
  openAlertIssues?: { number: number; marker: string }[];
} = {}) {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, args: unknown[]) => (calls[name] ??= []).push(args);

  return {
    calls,
    client: {
      async findOpenPlanIssue(_repo: unknown, marker: string) {
        record('findOpenPlanIssue', [marker]);
        return opts.openByMarker?.[marker] ?? null;
      },
      async getIssue(_repo: unknown, number: number) {
        record('getIssue', [number]);
        const body = opts.issueBodies?.[number];
        return body === undefined ? null : { number, body, state: 'open', labels: ['drift'], pullRequest: false };
      },
      async updateIssueBody(_repo: unknown, number: number, body: string) {
        record('updateIssueBody', [number, body]);
      },
      async createIssue(_repo: unknown, params: unknown) {
        record('createIssue', [params]);
        return { number: 999, url: 'https://example.invalid/999' };
      },
      async findOpenAlertIssues() {
        record('findOpenAlertIssues', []);
        return opts.openAlertIssues ?? [];
      },
      async closeIssue(_repo: unknown, number: number, comment?: string) {
        record('closeIssue', [number, comment]);
      },
    },
  };
}

describe('createIssuesForFindings', () => {
  test('files a new issue when no marker matches yet', async () => {
    const { client, calls } = mockGithub();
    await createIssuesForFindings({
      repo: repo as never,
      config: config as never,
      github: client as never,
      logger,
      findings: [finding()],
      category: 'drift/diff',
    });

    assert.equal(calls.createIssue?.length, 1);
    assert.equal(calls.updateIssueBody, undefined);
  });

  test('updates an existing issue whose body no longer matches the current finding', async () => {
    const marker = 'drift-alert:drift/diff:drift/npm/zod';
    const { client, calls } = mockGithub({
      openByMarker: { [marker]: 42 },
      issueBodies: { 42: `an old message\n\n<!-- ${marker} -->` },
    });

    await createIssuesForFindings({
      repo: repo as never,
      config: config as never,
      github: client as never,
      logger,
      findings: [finding()],
      category: 'drift/diff',
    });

    assert.equal(calls.createIssue, undefined, 'no duplicate is filed');
    assert.equal(calls.updateIssueBody?.length, 1);
    assert.equal(calls.updateIssueBody?.[0]?.[0], 42);
  });

  test('leaves an existing issue alone when nothing changed', async () => {
    const marker = 'drift-alert:drift/diff:drift/npm/zod';
    const body = `${finding().message}\n\n<!-- ${marker} -->`;
    const { client, calls } = mockGithub({
      openByMarker: { [marker]: 42 },
      issueBodies: { 42: body },
    });

    await createIssuesForFindings({
      repo: repo as never,
      config: config as never,
      github: client as never,
      logger,
      findings: [finding()],
      category: 'drift/diff',
    });

    assert.equal(calls.updateIssueBody, undefined);
    assert.equal(calls.createIssue, undefined);
  });

  test('closes an issue whose finding no longer reproduces', async () => {
    const { client, calls } = mockGithub({
      openAlertIssues: [{ number: 7, marker: 'drift-alert:drift/diff:drift/npm/left-pad' }],
    });

    await createIssuesForFindings({
      repo: repo as never,
      config: config as never,
      github: client as never,
      logger,
      findings: [],
      category: 'drift/diff',
    });

    assert.equal(calls.closeIssue?.length, 1);
    assert.equal(calls.closeIssue?.[0]?.[0], 7);
  });

  test('never closes an issue that belongs to the other category', async () => {
    // The outdated scan's own findings do not mention `left-pad`, but the
    // open issue for it was filed by the push-triggered pipeline
    // (`drift/diff`). It must survive an outdated-scan reconciliation pass.
    const { client, calls } = mockGithub({
      openAlertIssues: [{ number: 7, marker: 'drift-alert:drift/diff:drift/npm/left-pad' }],
    });

    await createIssuesForFindings({
      repo: repo as never,
      config: config as never,
      github: client as never,
      logger,
      findings: [],
      category: 'drift/outdated',
    });

    assert.equal(calls.closeIssue, undefined);
  });

  test('does nothing when the feature is off', async () => {
    const { client, calls } = mockGithub();
    await createIssuesForFindings({
      repo: repo as never,
      config: DEFAULT_CONFIG as never,
      github: client as never,
      logger,
      findings: [finding()],
      category: 'drift/diff',
    });

    assert.equal(Object.keys(calls).length, 0);
  });
});
