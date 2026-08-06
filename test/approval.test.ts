import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeApproval, canApprove } from '../dist/approval/authorize.js';
import { applyApproval } from '../dist/approval/apply.js';
import {
  parseApprovalMetadata,
  renderApprovalMetadata,
  renderDispatchMarker,
  findPriorDispatch,
} from '../dist/approval/metadata.js';
import {
  canonicalJson,
  planDigest,
  PLAN_SCHEMA_VERSION,
  SUPPORTED_PLAN_SCHEMA_VERSIONS,
} from '../dist/approval/digest.js';
import { analyzeRepository } from '../dist/analysis.js';
import { DriftConfigSchema } from '../dist/config/schema.js';
import { createLogger } from '../dist/util/logger.js';
import { buildPlan } from '../dist/plan/index.js';

/**
 * `/drift apply` is the one comment in this system that causes code to be
 * written. These tests are mostly about the cases that must *fail*: before this
 * work either runner would accept the command from any commenter, on any issue
 * whose body contained a `drift-commit:` marker the commenter could type
 * themselves.
 */

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const DIGEST = 'd'.repeat(64);

const logger = createLogger('error');

function footer(overrides: Partial<Record<string, string>> = {}): string {
  const values: Record<string, string> = {
    'drift-schema': String(PLAN_SCHEMA_VERSION),
    'drift-plan': 'plan_0123456789',
    'drift-plan-digest': DIGEST,
    'drift-commit': SHA_B,
    'drift-base-branch': 'main',
    ...overrides,
  };
  return Object.entries(values)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `<!-- ${k}: ${v} -->`)
    .join('\n');
}

function driftIssue(overrides: Record<string, unknown> = {}) {
  return {
    number: 7,
    body: `Drift found breaking changes.\n\n${footer()}`,
    labels: ['drift'],
    state: 'open',
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    action: 'created',
    comment: { body: '/drift apply', user: { login: 'maintainer' } },
    issue: driftIssue(),
    ...overrides,
  };
}

const allow = async () => 'write' as const;

describe('approval authorization', () => {
  test('an authorized maintainer is allowed', async () => {
    const result = await authorizeApproval({ request: request(), lookupPermission: allow });
    assert.equal(result.status, 'authorized');
    assert.equal(result.status === 'authorized' && result.actor, 'maintainer');
    assert.equal(result.status === 'authorized' && result.metadata.headSha, SHA_B);
  });

  test('write, maintain, and admin may approve; triage and read may not', async () => {
    for (const permission of ['write', 'maintain', 'admin'] as const) {
      assert.ok(canApprove(permission), `${permission} should be able to approve`);
      const result = await authorizeApproval({ request: request(), lookupPermission: async () => permission });
      assert.equal(result.status, 'authorized', `${permission} should be authorized`);
    }

    for (const permission of ['triage', 'read', 'none'] as const) {
      assert.ok(!canApprove(permission), `${permission} must not be able to approve`);
    }
  });

  test('a read-only commenter is refused', async () => {
    const result = await authorizeApproval({ request: request(), lookupPermission: async () => 'read' });
    assert.equal(result.status, 'rejected');
    assert.match(result.status === 'rejected' ? result.reason : '', /read.*permission/is);
  });

  test('a triage user is refused — triage cannot push', async () => {
    const result = await authorizeApproval({ request: request(), lookupPermission: async () => 'triage' });
    assert.equal(result.status, 'rejected');
  });

  test('an unknown permission fails closed', async () => {
    const result = await authorizeApproval({ request: request(), lookupPermission: async () => null });
    assert.equal(result.status, 'rejected');
    assert.match(result.status === 'rejected' ? result.reason : '', /could not confirm/i);
  });

  test('a permission lookup that throws fails closed', async () => {
    const result = await authorizeApproval({
      request: request(),
      lookupPermission: async () => {
        throw new Error('502 from GitHub');
      },
    });
    assert.equal(result.status, 'rejected');
    // The upstream error must not be echoed into a public issue comment.
    assert.ok(!/502/.test(result.status === 'rejected' ? result.reason : ''));
  });

  test('a comment on a pull request is not an approval', async () => {
    const result = await authorizeApproval({
      request: request({ issue: driftIssue({ pull_request: { url: 'https://…' } }) }),
      lookupPermission: allow,
    });
    assert.equal(result.status, 'not-an-approval');
  });

  test('an issue Drift did not file is not an approval, however convincing the body', async () => {
    // The exact attack: a user opens their own issue, pastes a real-looking
    // footer, and comments the command. Provenance comes from the label, which
    // they cannot apply without the permission they are trying to obtain.
    const result = await authorizeApproval({
      request: request({ issue: driftIssue({ labels: [] }) }),
      lookupPermission: allow,
    });
    assert.equal(result.status, 'not-an-approval');
    assert.match(result.reason, /label/i);
  });

  test('an edited or deleted comment is not an approval', async () => {
    for (const action of ['edited', 'deleted', undefined]) {
      const result = await authorizeApproval({ request: request({ action }), lookupPermission: allow });
      assert.equal(result.status, 'not-an-approval');
    }
  });

  test('Drift cannot approve its own plan', async () => {
    const result = await authorizeApproval({
      request: request({ comment: { body: '/drift apply', user: { login: 'github-actions[bot]' } } }),
      lookupPermission: allow,
      selfLogins: ['github-actions[bot]'],
    });
    assert.equal(result.status, 'not-an-approval');
  });

  test('the command must stand alone, so quoting it is not approving it', async () => {
    const quoted = 'You can comment `/drift apply` when you are ready — see the docs.';
    const result = await authorizeApproval({
      request: request({ comment: { body: quoted, user: { login: 'maintainer' } } }),
      lookupPermission: allow,
    });
    assert.equal(result.status, 'not-an-approval');
  });

  test('the command is still recognised with surrounding lines', async () => {
    const result = await authorizeApproval({
      request: request({
        comment: { body: 'looks right to me\n/drift apply\nthanks', user: { login: 'maintainer' } },
      }),
      lookupPermission: allow,
    });
    assert.equal(result.status, 'authorized');
  });

  test('a closed issue is refused', async () => {
    const result = await authorizeApproval({
      request: request({ issue: driftIssue({ state: 'closed' }) }),
      lookupPermission: allow,
    });
    assert.equal(result.status, 'rejected');
  });

  test('permission is never consulted before provenance', async () => {
    let asked = false;
    await authorizeApproval({
      request: request({ issue: driftIssue({ labels: [] }) }),
      lookupPermission: async () => {
        asked = true;
        return 'admin';
      },
    });
    assert.equal(asked, false, 'a non-Drift issue must not cost a permission API call');
  });
});

describe('approval metadata parsing', () => {
  test('round-trips', () => {
    const metadata = {
      schemaVersion: PLAN_SCHEMA_VERSION,
      planId: 'plan_0123456789',
      planDigest: DIGEST,
      headSha: SHA_B,
      baseBranch: 'release/2.x',
    };
    const parsed = parseApprovalMetadata(`text\n${renderApprovalMetadata(metadata)}`);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.ok && parsed.metadata, metadata);
  });

  test('a body with no footer is not a Drift issue', () => {
    const parsed = parseApprovalMetadata('just an ordinary issue');
    assert.equal(parsed.ok, false);
  });

  test('every key is required', () => {
    for (const key of ['drift-schema', 'drift-plan', 'drift-plan-digest', 'drift-commit', 'drift-base-branch']) {
      const body = footer()
        .split('\n')
        .filter((line) => !line.includes(`${key}:`))
        .join('\n');
      const parsed = parseApprovalMetadata(body);
      assert.equal(parsed.ok, false, `${key} should be required`);
      assert.match(parsed.ok ? '' : parsed.reason, new RegExp(key));
    }
  });

  test('a duplicated key is rejected rather than resolved', () => {
    // Splicing a second value past a parser that takes the first or the last
    // match is the classic way to smuggle one in.
    const body = `${footer()}\n<!-- drift-commit: ${SHA_C} -->`;
    const parsed = parseApprovalMetadata(body);
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? '' : parsed.reason, /twice|2 times/i);
  });

  test('an abbreviated commit SHA is rejected', () => {
    const parsed = parseApprovalMetadata(footer({ 'drift-commit': 'abc1234' }));
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? '' : parsed.reason, /40-character/);
  });

  test('a malformed digest is rejected', () => {
    for (const bad of ['not-hex', 'a'.repeat(63), 'A'.repeat(64), '']) {
      assert.equal(parseApprovalMetadata(footer({ 'drift-plan-digest': bad })).ok, false, bad || '(empty)');
    }
  });

  test('an unsupported schema version is refused explicitly', () => {
    const parsed = parseApprovalMetadata(footer({ 'drift-schema': '99' }));
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? '' : parsed.reason, /schema v99/);
  });

  test('an issue from the previous schema names the version, not a phantom change', () => {
    // A v1 issue records a digest computed under v1 rules, so recomputing it
    // under the current rules could only ever mismatch. Reporting that as "the
    // plan changed" would be false and would send someone hunting for a change
    // that never happened.
    const parsed = parseApprovalMetadata(footer({ 'drift-schema': '1' }));
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? '' : parsed.reason, /schema v1/);
    assert.match(parsed.ok ? '' : parsed.reason, /re-run drift/i);
    assert.ok(
      !/does not match|plan changed/i.test(parsed.ok ? '' : parsed.reason),
      'a schema mismatch must not be reported as a changed plan',
    );
  });

  test('the current schema version is the one Drift writes', () => {
    assert.deepEqual(SUPPORTED_PLAN_SCHEMA_VERSIONS, [PLAN_SCHEMA_VERSION]);
  });

  test('an invalid branch name is rejected', () => {
    for (const bad of ['has space', '-leading', 'trailing.', 'a..b', 'x.lock', '/abs', 'a//b', 'ref~1']) {
      assert.equal(parseApprovalMetadata(footer({ 'drift-base-branch': bad })).ok, false, bad);
    }
  });

  test('a plausible branch name is accepted', () => {
    for (const good of ['main', 'release/2.x', 'feature/JIRA-123_thing']) {
      assert.equal(parseApprovalMetadata(footer({ 'drift-base-branch': good })).ok, true, good);
    }
  });
});

describe('dispatch markers', () => {
  const marker = renderDispatchMarker({ planDigest: DIGEST, branchName: 'drift/x', pullRequestNumber: 42 });

  test('a marker Drift wrote is found', () => {
    const prior = findPriorDispatch([{ body: `done\n${marker}`, authorIsDrift: true }], DIGEST);
    assert.equal(prior?.pullRequestNumber, 42);
    assert.equal(prior?.branchName, 'drift/x');
  });

  test('a marker from anyone else is ignored', () => {
    // Otherwise a forged marker would be a denial of service: comment one, and
    // the real approval becomes a permanent no-op.
    assert.equal(findPriorDispatch([{ body: marker, authorIsDrift: false }], DIGEST), null);
  });

  test('a marker for a different plan does not match', () => {
    assert.equal(findPriorDispatch([{ body: marker, authorIsDrift: true }], 'e'.repeat(64)), null);
  });
});

describe('plan digest', () => {
  const repo = { owner: 'acme', repo: 'app', baseBranch: 'main', beforeSha: SHA_A, afterSha: SHA_B };
  const config = DriftConfigSchema.parse({});
  const change = {
    name: 'acme-sdk',
    ecosystem: 'npm' as const,
    from: '1.0.0',
    to: '2.0.0',
    kind: 'runtime' as const,
    bump: 'major' as const,
    manifestPath: 'package.json',
  };
  const input = {
    repo,
    config,
    changes: [change],
    evidence: [
      {
        id: 'ev_1',
        source: 'type-surface-diff' as const,
        dependency: 'acme-sdk',
        title: 'API surface diff',
        content: '`createClient` removed',
        weight: 1,
      },
    ],
    breakingChanges: [
      {
        id: 'bc_1',
        dependency: 'acme-sdk',
        kind: 'removed-export' as const,
        summary: '`createClient` was removed',
        remediation: 'Use `create`',
        symbols: ['createClient'],
        confidence: 'high' as const,
        citations: ['ev_1'],
      },
    ],
    impactSites: [
      {
        breakingChangeId: 'bc_1',
        file: 'src/a.ts',
        line: 3,
        excerpt: 'createClient()',
        matchedSymbol: 'createClient',
        confidence: 'high' as const,
      },
    ],
  };

  test('is stable across identical runs', () => {
    assert.equal(planDigest(buildPlan(input)), planDigest(buildPlan(input)));
  });

  test('excludes createdAt, which changes on every run', () => {
    const plan = buildPlan(input);
    const later = { ...plan, createdAt: new Date(Date.now() + 60_000).toISOString() };
    assert.equal(planDigest(plan), planDigest(later));
    assert.notEqual(plan.createdAt, later.createdAt);
  });

  test('changes when the plan gains a breaking change', () => {
    const extra = {
      ...input,
      breakingChanges: [
        ...input.breakingChanges,
        { ...input.breakingChanges[0]!, id: 'bc_2', summary: '`connect` was removed', symbols: ['connect'] },
      ],
    };
    assert.notEqual(planDigest(buildPlan(input)), planDigest(buildPlan(extra)));
  });

  test('changes when the quoted evidence changes', () => {
    const edited = {
      ...input,
      evidence: [{ ...input.evidence[0]!, content: 'something entirely different' }],
    };
    assert.notEqual(planDigest(buildPlan(input)), planDigest(buildPlan(edited)));
  });

  test('changes when an impact site moves to another file', () => {
    const moved = {
      ...input,
      impactSites: [{ ...input.impactSites[0]!, file: 'src/elsewhere.ts' }],
    };
    assert.notEqual(planDigest(buildPlan(input)), planDigest(buildPlan(moved)));
  });

  test('is independent of key order in the serialized form', () => {
    assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
    assert.equal(canonicalJson({ a: undefined, b: 1 }), canonicalJson({ b: 1 }));
  });

  test('the plan id alone does not identify a plan, which is why the digest exists', () => {
    // Both plans describe the same commit and so share an id; only the digest
    // distinguishes them. Approving an id would have approved either.
    const bigger = {
      ...input,
      breakingChanges: [
        ...input.breakingChanges,
        { ...input.breakingChanges[0]!, id: 'bc_2', summary: 'more', symbols: ['other'] },
      ],
    };
    assert.equal(buildPlan(input).id, buildPlan(bigger).id);
    assert.notEqual(planDigest(buildPlan(input)), planDigest(buildPlan(bigger)));
  });
});

/* --------------------------------------------------------------------------
 * End-to-end: the whole gate, against the real analysis pipeline.
 *
 * The pipeline runs for real here — no stubbed analyzer — with every network
 * evidence source switched off so the test stays offline and deterministic.
 * That is what makes the digest assertions meaningful: the digest is recomputed
 * by the same code path production uses.
 * ----------------------------------------------------------------------- */

const CONFIG_YAML = `
mode: approve
evidence:
  githubReleases: false
  changelog: false
  typeSurface: false
  openapi: false
rationale:
  security: false
  maintenance: false
  summary: false
`;

const PKG_BEFORE = JSON.stringify({ name: 'app', dependencies: { 'acme-sdk': '1.0.0' } });
const PKG_AFTER = JSON.stringify({ name: 'app', dependencies: { 'acme-sdk': '2.0.0' } });

/**
 * The commit range an approval analyses is derived from the plan footer, so
 * "before" is `${headSha}^` — not whatever the event happened to carry. The
 * fixture uses the same refs the runner does, which is the point.
 */
const BEFORE_REF = `${SHA_B}^`;

function fakeProvider() {
  return {
    changedFiles: async () => ['package.json'],
    readFile: async (path: string, ref: string) =>
      path === 'package.json' ? (ref === BEFORE_REF ? PKG_BEFORE : PKG_AFTER) : null,
  };
}

/** The digest production will compute for this fixture. */
async function expectedDigest(): Promise<string> {
  const { plan } = await analyzeRepository({
    repo: { owner: 'acme', repo: 'app', baseBranch: 'main', beforeSha: BEFORE_REF, afterSha: SHA_B },
    config: DriftConfigSchema.parse({
      mode: 'approve',
      evidence: { githubReleases: false, changelog: false, typeSurface: false, openapi: false },
      rationale: { security: false, maintenance: false, summary: false },
    }),
    logger,
    provider: fakeProvider(),
  });
  assert.ok(plan, 'the fixture should produce a plan');
  return planDigest(plan);
}

interface Calls {
  comments: string[];
  branches: string[];
  checkRuns: string[];
}

function fakeGitHub(overrides: Record<string, unknown> = {}) {
  const calls: Calls = { comments: [], branches: [], checkRuns: [] };

  const client = {
    getAuthenticatedLogin: async () => 'drift[bot]',
    getCollaboratorPermission: async () => 'write',
    commitExists: async () => true,
    getBranchHead: async () => SHA_B,
    listIssueComments: async () => [],
    getIssue: async () => ({
      number: 7,
      body: `Drift found breaking changes.\n\n${footer()}`,
      state: 'open',
      labels: ['drift'],
      pullRequest: false,
    }),
    readFile: async (_repo: unknown, path: string, ref: string) => {
      if (path.endsWith('drift.yml') || path.endsWith('drift.yaml')) return CONFIG_YAML;
      if (path === 'package.json') return ref === BEFORE_REF ? PKG_BEFORE : PKG_AFTER;
      return null;
    },
    asRepoProvider: () => fakeProvider(),
    commentOnIssue: async (_repo: unknown, _n: number, body: string) => {
      calls.comments.push(body);
    },
    createCheckRun: async (_repo: unknown, p: { title: string }) => {
      calls.checkRuns.push(p.title);
    },
    createBranch: async (_repo: unknown, name: string) => {
      calls.branches.push(name);
      return true;
    },
    findOpenPlanIssue: async () => null,
    createIssue: async () => ({ number: 8, url: 'https://example.invalid/8' }),
    getDefaultBranch: async () => 'main',
    ...overrides,
  };

  return { client, calls };
}

async function run(
  overrides: Record<string, unknown> = {},
  payloadOverrides: Record<string, unknown> = {},
  applyOverrides: Record<string, unknown> = {},
) {
  const { client, calls } = fakeGitHub(overrides);
  const outcome = await applyApproval({
    payload: {
      action: 'created',
      comment: { body: '/drift apply', user: { login: 'maintainer' } },
      issue: { number: 7 },
      repository: { full_name: 'acme/app' },
      ...payloadOverrides,
    },
    owner: 'acme',
    repo: 'app',
    // The fake stands in for the client at the same call sites the real one is
    // used from; the pipeline underneath is entirely real.
    github: client as never,
    logger,
    ...applyOverrides,
  });
  return { outcome, calls };
}

/** An in-memory stand-in for the durable `dispatchStore`. */
function fakeDispatchStore() {
  const records = new Map<string, { taskId?: string; branchName?: string; pullRequestNumber?: number }>();
  return {
    store: {
      find: async (owner: string, repo: string, planDigest: string) =>
        records.get(`${owner}/${repo}/${planDigest}`) ?? null,
      record: async (
        owner: string,
        repo: string,
        planDigest: string,
        result: { taskId?: string; branchName?: string; pullRequestNumber?: number },
      ) => {
        const key = `${owner}/${repo}/${planDigest}`;
        if (records.has(key)) return;
        records.set(key, {
          ...(result.taskId ? { taskId: result.taskId } : {}),
          ...(result.branchName ? { branchName: result.branchName } : {}),
          ...(result.pullRequestNumber !== undefined ? { pullRequestNumber: result.pullRequestNumber } : {}),
        });
      },
    },
    records,
  };
}

describe('applying an approval, end to end', () => {
  test('a read-only commenter is refused and told why, and no branch is created', async () => {
    const { outcome, calls } = await run({ getCollaboratorPermission: async () => 'read' });
    assert.equal(outcome.status, 'rejected');
    assert.equal(calls.branches.length, 0);
    assert.equal(calls.comments.length, 1);
    assert.match(calls.comments[0]!, /did not apply/i);
  });

  test('a reviewed commit that no longer exists is refused', async () => {
    const { outcome, calls } = await run({ commitExists: async () => false });
    assert.equal(outcome.status, 'rejected');
    assert.match(outcome.status === 'rejected' ? outcome.reason : '', /no longer in this repository/);
    assert.equal(calls.branches.length, 0);
  });

  test('a base branch that has advanced makes the plan stale', async () => {
    const { outcome, calls } = await run({ getBranchHead: async () => SHA_C });
    assert.equal(outcome.status, 'rejected');
    assert.match(outcome.status === 'rejected' ? outcome.reason : '', /has advanced/);
    assert.equal(calls.branches.length, 0);
  });

  test('a deleted base branch is refused', async () => {
    const { outcome } = await run({ getBranchHead: async () => null });
    assert.equal(outcome.status, 'rejected');
    assert.match(outcome.status === 'rejected' ? outcome.reason : '', /no longer exists/);
  });

  test('a digest that does not match the recomputed plan is refused', async () => {
    // The recorded digest here is `d`*64, which the fixture will never produce.
    const { outcome, calls } = await run();
    assert.equal(outcome.status, 'rejected');
    assert.match(outcome.status === 'rejected' ? outcome.reason : '', /does not match/);
    assert.equal(calls.branches.length, 0);
  });

  test('a matching digest passes verification and reaches dispatch', async () => {
    const digest = await expectedDigest();
    const { outcome } = await run({
      getIssue: async () => ({
        number: 7,
        body: `Drift found breaking changes.\n\n${footer({ 'drift-plan-digest': digest })}`,
        state: 'open',
        labels: ['drift'],
        pullRequest: false,
      }),
    });
    assert.equal(outcome.status, 'applied', 'a verified plan should be applied');
  });

  test('a second /drift apply for the same plan is a no-op', async () => {
    const digest = await expectedDigest();
    const marker = renderDispatchMarker({ planDigest: digest, branchName: 'drift/x', pullRequestNumber: 42 });

    const { outcome, calls } = await run({
      getIssue: async () => ({
        number: 7,
        body: `Drift found breaking changes.\n\n${footer({ 'drift-plan-digest': digest })}`,
        state: 'open',
        labels: ['drift'],
        pullRequest: false,
      }),
      listIssueComments: async () => [{ body: `applied\n${marker}`, authorLogin: 'drift[bot]' }],
    });

    assert.equal(outcome.status, 'already-applied');
    assert.match(outcome.status === 'already-applied' ? outcome.message : '', /#42/);
    assert.equal(calls.branches.length, 0, 'a duplicate approval must not create a second branch');
  });

  test('a durable dispatch record short-circuits before the comment scan', async () => {
    const digest = await expectedDigest();
    const { store, records } = fakeDispatchStore();
    records.set(`acme/app/${digest}`, { branchName: 'drift/x', pullRequestNumber: 9 });

    let commentsListed = false;
    const { outcome, calls } = await run(
      {
        getIssue: async () => ({
          number: 7,
          body: `Drift found breaking changes.\n\n${footer({ 'drift-plan-digest': digest })}`,
          state: 'open',
          labels: ['drift'],
          pullRequest: false,
        }),
        listIssueComments: async () => {
          commentsListed = true;
          return [];
        },
      },
      {},
      { dispatchStore: store },
    );

    assert.equal(outcome.status, 'already-applied');
    assert.match(outcome.status === 'already-applied' ? outcome.message : '', /#9/);
    assert.equal(calls.branches.length, 0);
    assert.equal(commentsListed, false, 'the durable store answers before the comment scan runs');
  });

  test('an unreadable comment list refuses rather than risking a duplicate dispatch', async () => {
    const digest = await expectedDigest();
    const { outcome } = await run({
      getIssue: async () => ({
        number: 7,
        body: `Drift found breaking changes.\n\n${footer({ 'drift-plan-digest': digest })}`,
        state: 'open',
        labels: ['drift'],
        pullRequest: false,
      }),
      listIssueComments: async () => {
        throw new Error('403');
      },
    });
    assert.equal(outcome.status, 'rejected');
    assert.match(outcome.status === 'rejected' ? outcome.reason : '', /already applied/i);
  });

  test('an ordinary comment is ignored silently', async () => {
    const { outcome, calls } = await run({}, { comment: { body: 'looks good to me', user: { login: 'someone' } } });
    assert.equal(outcome.status, 'ignored');
    assert.equal(calls.comments.length, 0, 'Drift must not comment on ordinary conversation');
  });

  test('an issue Drift did not file is ignored silently', async () => {
    const { outcome, calls } = await run({
      getIssue: async () => ({ number: 7, body: footer(), state: 'open', labels: [], pullRequest: false }),
    });
    assert.equal(outcome.status, 'ignored');
    assert.equal(calls.comments.length, 0);
  });

  test('a checkout at the wrong commit is not used for localization', async () => {
    // On `issue_comment`, `actions/checkout` takes the default branch — which
    // is not necessarily the branch this plan targets. Localizing there would
    // report exact file-and-line impact sites from a tree that was never
    // analysed: confident, and wrong.
    const digest = await expectedDigest();
    const { client } = fakeGitHub({
      getIssue: async () => ({
        number: 7,
        body: footer({ 'drift-plan-digest': digest }),
        state: 'open',
        labels: ['drift'],
        pullRequest: false,
      }),
    });

    const warnings: string[] = [];
    const outcome = await applyApproval({
      payload: {
        action: 'created',
        comment: { body: '/drift apply', user: { login: 'maintainer' } },
        issue: { number: 7 },
        repository: { full_name: 'acme/app' },
      },
      owner: 'acme',
      repo: 'app',
      github: client as never,
      logger: { ...logger, warn: (m: string) => warnings.push(m) } as never,
      // This repository, whose HEAD is certainly not `bbbb…`.
      workspace: process.cwd(),
    });

    assert.equal(outcome.status, 'applied', 'the approval still proceeds');
    assert.ok(
      warnings.some((w) => /skipping localization/i.test(w)),
      'it should say it skipped localization rather than localize the wrong tree',
    );
  });

  test('the issue is re-read rather than trusted from the event payload', async () => {
    // Action payloads truncate long bodies, and the footer is at the bottom —
    // so on exactly the large plans that most need review it would be missing.
    let fetched = false;
    await run(
      {
        getIssue: async () => {
          fetched = true;
          return { number: 7, body: footer(), state: 'open', labels: ['drift'], pullRequest: false };
        },
      },
      { issue: { number: 7, body: 'truncated…', labels: [{ name: 'drift' }] } },
    );
    assert.ok(fetched, 'the issue body must come from the API, not the event');
  });
});
