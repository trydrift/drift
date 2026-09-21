import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createDriftMcpServer } from '../dist/mcp/server.js';
import { AgentPlanSession } from '../dist/mcp/agent-tools.js';
import { runWorkingTreeChecks } from '../dist/agent-context/verify.js';
import { AGENT_BRIEF_BUDGET, BYTES_PER_TOKEN } from '../dist/agent-context/budget.js';
import { DEFAULT_CONFIG } from '../dist/config/schema.js';
import type { RemediationPlan } from '../dist/types.js';

/**
 * The agent tools over the real MCP protocol, with the analysis replaced by a
 * fixture plan — the plan Drift produced for ESLint 8 → 10 in the first agent
 * benchmark. What is under test is the interface: a small first answer,
 * detail on request, and nothing unrelated leaking into either.
 */

const eslint = (): RemediationPlan =>
  JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/agent-context/eslint-8-to-10.plan.json.gz', import.meta.url))).toString('utf8'));

interface Harness {
  call: (name: string, args?: Record<string, unknown>) => Promise<{ text: string; isError: boolean; structured: unknown }>;
  plannerCalls: { before?: string; after?: string; verify: boolean }[];
  checkerCalls: { only?: readonly string[]; changes?: { name: string }[] }[];
  list: () => Promise<{ name: string; description?: string }[]>;
  instructions: () => string;
}

async function harness(plan: RemediationPlan | null = eslint()): Promise<Harness> {
  const plannerCalls: Harness['plannerCalls'] = [];
  const checkerCalls: Harness['checkerCalls'] = [];
  const session = new AgentPlanSession(
    async (request) => {
      plannerCalls.push({ before: request.before, after: request.after, verify: request.verify });
      return {
        plan,
        config: DEFAULT_CONFIG,
        range: plan ? { before: 'a', after: 'b' } : null,
        summary: plan ? 'planned' : 'No dependency change found in this checkout.',
        checks: [{ label: 'npm test', kind: 'test' }],
      };
    },
    async (request) => {
      checkerCalls.push({ only: request.only, changes: request.changes as { name: string }[] | undefined });
      return { text: 'FAIL npm run build (3s)\n  src/a.ts:1 TS2339: nope\n  full log: /tmp/x.log', bytes: 60, estimatedTokens: 20, passed: false, checks: [], declared: [] };
    },
  );
  const server = createDriftMcpServer(session);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientSide);
  return {
    plannerCalls,
    checkerCalls,
    list: async () => (await client.listTools()).tools,
    instructions: () => client.getInstructions() ?? '',
    call: async (name, args = {}) => {
      const result = (await client.callTool({ name, arguments: { directory: '/repo', ...args } })) as {
        content: { text: string }[];
        isError?: boolean;
        structuredContent?: unknown;
      };
      return { text: result.content.map((c) => c.text).join(''), isError: Boolean(result.isError), structured: result.structuredContent };
    },
  };
}

describe('MCP agent tools — planning', () => {
  test('the agent tools are advertised with descriptions that say they are bounded and pull-based', async () => {
    const h = await harness();
    const tools = await h.list();
    for (const name of ['plan_upgrade', 'get_finding', 'get_evidence', 'verify_upgrade']) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, name);
      assert.ok((tool.description ?? '').length > 120, `${name} describes itself`);
    }
    const planDescription = tools.find((t) => t.name === 'plan_upgrade')!.description!;
    assert.match(planDescription, /under 2,300 tokens/);
    // The plan is a head start, not a boundary. The description used to tell
    // agents not to read the package changelog or API themselves, and measured
    // on real upgrades that is what made them miss what Drift cannot see.
    assert.match(planDescription, /It is not the whole job/);
    assert.match(planDescription, /cannot see a name that\s+survived the upgrade and changed meaning/);
    assert.match(planDescription, /run verify_upgrade until the checks pass/);
    assert.doesNotMatch(planDescription, /rather than reading the package changelog/);
  });

  test('the server tells the client which tool answers which question, briefly', async () => {
    const h = await harness();
    const instructions = h.instructions();
    assert.match(instructions, /call plan_upgrade first/);
    assert.match(instructions, /check_upgrades or explain_upgrade/);
    // Paid on every turn of every session with Drift connected.
    assert.ok(Buffer.byteLength(instructions) < 700, `${Buffer.byteLength(instructions)} bytes`);
  });

  test('plan_upgrade returns the compact brief, not the report', async () => {
    const h = await harness();
    const { text, isError, structured } = await h.call('plan_upgrade');
    assert.equal(isError, false);
    assert.equal(structured, undefined, 'text only: Claude Code would show the model structuredContent instead of this text');
    assert.ok(Buffer.byteLength(text) <= AGENT_BRIEF_BUDGET.maxTokens * BYTES_PER_TOKEN, `${Buffer.byteLength(text)} bytes`);
    assert.match(text, /^# Drift agent brief: eslint 8\.57\.1 → 10\.0\.0/);
    assert.match(text, /bc_6843abffd2/);
    assert.match(text, /286 upstream breaking changes with no located usage/);
    // One of the 286: present in the plan, absent from the brief.
    assert.ok(eslint().breakingChanges.some((c) => c.summary.includes('BaseConfig.extends')));
    assert.doesNotMatch(text, /BaseConfig\.extends/);
    assert.deepEqual(h.plannerCalls, [{ before: undefined, after: undefined, verify: true }]);
  });

  test('the plan is computed once per checkout, so the agent’s own manifest edits do not replace it', async () => {
    const h = await harness();
    await h.call('plan_upgrade');
    const second = await h.call('plan_upgrade');
    assert.equal(h.plannerCalls.length, 1);
    assert.match(second.text, /Plan computed earlier in this session; pass refresh: true to re-analyse/);
    await h.call('plan_upgrade', { refresh: true });
    await h.call('plan_upgrade', { before: 'abc' });
    assert.equal(h.plannerCalls.length, 3);
  });

  test('a verified plan is not replaced by an unverified request, but an unverified one is upgraded on request', async () => {
    const h = await harness();
    await h.call('plan_upgrade', { verify: false });
    await h.call('plan_upgrade', { verify: false });
    assert.equal(h.plannerCalls.length, 1);
    await h.call('plan_upgrade', { verify: true });
    assert.equal(h.plannerCalls.length, 2);
    await h.call('plan_upgrade', { verify: false });
    assert.equal(h.plannerCalls.length, 2);
  });

  test('json format returns one bounded structured object, and the text is the same object', async () => {
    const h = await harness();
    const { text, structured } = await h.call('plan_upgrade', { format: 'json' });
    assert.ok(structured && typeof structured === 'object');
    assert.deepEqual(JSON.parse(text), structured);
    assert.ok(Buffer.byteLength(text) <= AGENT_BRIEF_BUDGET.maxTokens * BYTES_PER_TOKEN, `${Buffer.byteLength(text)} bytes`);
    const view = structured as { findings: { id: string }[]; omitted: { noLocatedUsage: number } };
    assert.equal(view.omitted.noLocatedUsage, 286);
    const unknown = new Set(eslint().dispositions!.filter((d) => d.state === 'unknown').map((d) => d.changeId));
    // JSON is less dense than the prose brief: whatever does not fit is named, never dropped.
    const accounted = [...view.findings.map((f) => f.id), ...(structured as { findingIdsNotShown: string[] }).findingIdsNotShown].sort();
    assert.equal(view.findings.length + (structured as { findingsNotShown: number }).findingsNotShown, 5);
    assert.deepEqual(accounted, ['bc_2ba7ffc9b7', 'bc_3ab894d22c', 'bc_6843abffd2', 'bc_a770541f05', 'bc_c5df06643e']);
    for (const finding of view.findings) assert.equal(unknown.has(finding.id), false, finding.id);
  });

  test('no dependency change is a plain answer, not an error', async () => {
    const h = await harness(null);
    const { text, isError } = await h.call('plan_upgrade');
    assert.equal(isError, false);
    assert.match(text, /No dependency change found/);
  });
});

describe('MCP agent tools — detail on request', () => {
  test('detail before a plan fails clearly', async () => {
    const h = await harness();
    const { text, isError } = await h.call('get_finding', { id: 'bc_6843abffd2' });
    assert.equal(isError, true);
    assert.match(text, /Call plan_upgrade first/);
  });

  test('get_finding returns only the finding asked for', async () => {
    const h = await harness();
    await h.call('plan_upgrade');
    const { text, isError } = await h.call('get_finding', { id: 'bc_6843abffd2' });
    assert.equal(isError, false);
    assert.match(text, /^# bc_6843abffd2/);
    assert.match(text, /eslint-rules\/no-unsafe-execa\.test\.js:11/);
    assert.doesNotMatch(text, /bc_c5df06643e|bc_a770541f05|\.github\/workflows/);
    assert.ok(Buffer.byteLength(text) <= 2_000 * BYTES_PER_TOKEN);
  });

  test('an unknown id is an error that says what a valid one looks like', async () => {
    const h = await harness();
    await h.call('plan_upgrade');
    const { text, isError } = await h.call('get_finding', { id: 'bc_does_not_exist' });
    assert.equal(isError, true);
    assert.match(text, /No finding with id "bc_does_not_exist"/);
  });

  test('get_evidence for a finding does not leak the other changes in a shared record', async () => {
    const h = await harness();
    await h.call('plan_upgrade');
    const plan = eslint();
    const change = plan.breakingChanges.find((c) => c.id === 'bc_6843abffd2')!;
    const record = plan.evidence.find((e) => change.citations.includes(e.id))!;
    // The cited record describes far more than this one change…
    assert.ok((record.findings ?? []).length > 100);
    const { text, isError } = await h.call('get_evidence', { finding: 'bc_6843abffd2' });
    assert.equal(isError, false);
    // …and only this change's part of it comes back.
    assert.match(text, /RuleTester\.valid/);
    assert.doesNotMatch(text, /RuleTester\.invalid/);
    assert.ok(Buffer.byteLength(text) < 1_000, `${Buffer.byteLength(text)} bytes`);
  });

  test('get_evidence returns a record that fits whole with no continuation, text and JSON alike', async () => {
    const h = await harness();
    await h.call('plan_upgrade');
    const record = eslint().evidence.find((e) => e.id === 'ev_100f063a09')!;
    const text = await h.call('get_evidence', { evidence: 'ev_100f063a09' });
    assert.match(text.text, /eslint v9\.0\.0 release notes/);
    assert.doesNotMatch(text.text, /continues: request offset/);
    const json = await h.call('get_evidence', { evidence: 'ev_100f063a09', format: 'json' });
    const view = json.structured as { records: { excerpt: string; nextOffset: number | null; contentChars: number }[] };
    assert.equal(view.records[0]!.contentChars, record.content.length);
    assert.equal(view.records[0]!.excerpt, record.content);
    assert.equal(view.records[0]!.nextOffset, null);
    assert.ok(Buffer.byteLength(json.text) <= 2_500 * BYTES_PER_TOKEN);
  });

  test('verify_upgrade passes the upgraded manifest dependencies and returns the checker’s concise report', async () => {
    const h = await harness();
    await h.call('plan_upgrade');
    const { text } = await h.call('verify_upgrade', { only: ['build'] });
    assert.match(text, /FAIL npm run build/);
    assert.deepEqual(h.checkerCalls[0]!.only, ['build']);
    assert.ok(h.checkerCalls[0]!.changes!.some((c) => c.name === 'eslint'));
  });
});

describe('working-tree checks', () => {
  test('a failing build is summarised with its compiler errors and a log path, not its whole output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'drift-verify-'));
    const noise = Array.from({ length: 400 }, (_, i) => `console.log('progress line ${i}');`).join('');
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        version: '1.0.0',
        devDependencies: { eslint: '^10.0.0' },
        scripts: {
          build: `node -e "${noise} console.error('src/a.ts(3,5): error TS2339: Property \\'v\\' does not exist on type \\'TxData\\'.'); process.exit(1)"`,
          test: 'node -e "process.exit(0)"',
        },
      }),
    );
    await writeFile(join(dir, 'package-lock.json'), JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: {} }));

    const report = await runWorkingTreeChecks({
      directory: dir,
      changes: [{ name: 'eslint', ecosystem: 'npm', from: '8.57.1', to: '10.0.0', kind: 'dev', bump: 'major', manifestPath: 'package.json' }],
    });
    const build = report.checks.find((c) => c.label.includes('build'));
    assert.ok(build, report.text);
    assert.equal(build.status, 'failed');
    assert.deepEqual(build.diagnostics.map((d) => `${d.file}:${d.line}`), ['src/a.ts:3']);
    assert.ok(build.logPath && existsSync(build.logPath));
    assert.match(readFileSync(build.logPath!, 'utf8'), /progress line 399/);
    assert.doesNotMatch(report.text, /progress line/);
    assert.match(report.text, /eslint: declared \^10\.0\.0 in package\.json \(upgrade target 10\.0\.0\)/);
    assert.equal(report.passed, false);
    assert.ok(report.estimatedTokens < 400);
  });
});

describe('MCP agent tools — held plans cannot go stale or cross ranges', () => {
  const keyring = (): RemediationPlan =>
    JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/agent-context/ethereumjs-tx-4-to-5.plan.json.gz', import.meta.url))).toString('utf8'));

  /** Plan A (ESLint) for the checkout's own change; plan B (@ethereumjs/tx) for any explicit range; `none` switches the checkout to no change. */
  async function sequenceHarness() {
    const state = { none: false, calls: 0 };
    const a = eslint();
    const b = keyring();
    assert.notEqual(a.id, b.id);
    const session = new AgentPlanSession(async (request) => {
      state.calls += 1;
      const plan = request.before || request.after ? b : state.none ? null : a;
      return { plan, config: DEFAULT_CONFIG, range: null, summary: plan ? 'planned' : 'No dependency change found in this checkout.', checks: [] };
    });
    const server = createDriftMcpServer(session);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(clientSide);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = (await client.callTool({ name, arguments: { directory: '/repo', ...args } })) as { content: { text: string }[]; isError?: boolean };
      return { text: result.content.map((c) => c.text).join(''), isError: Boolean(result.isError) };
    };
    return { state, a, b, call };
  }

  test('an explicit range never replaces the checkout plan, and detail for it needs its plan id', async () => {
    const { state, a, b, call } = await sequenceHarness();
    assert.match((await call('plan_upgrade')).text, /Drift agent brief: eslint 8\.57\.1/);
    const ranged = await call('plan_upgrade', { before: 'x', after: 'y' });
    assert.match(ranged.text, /Drift agent brief: @ethereumjs\/tx 4\.2\.0/);
    assert.match(ranged.text, new RegExp(`pass plan: "${b.id}"`));
    // The checkout plan is still A, reused, not B.
    const again = await call('plan_upgrade');
    assert.match(again.text, /Drift agent brief: eslint 8\.57\.1/);
    assert.doesNotMatch(again.text, /@ethereumjs/);
    assert.equal(state.calls, 2);
    // Detail without a plan id reads A; B's finding is not in A.
    assert.equal((await call('get_finding', { id: 'bc_6843abffd2' })).isError, false);
    const bFinding = 'measured:npm @ethereumjs/tx';
    assert.equal((await call('get_finding', { id: bFinding })).isError, true);
    // Naming B's plan id reads B, and only B.
    const fromB = await call('get_finding', { id: bFinding, plan: b.id });
    assert.equal(fromB.isError, false);
    assert.match(fromB.text, /src\/ledger-keyring\.ts:329/);
    assert.equal((await call('get_finding', { id: 'bc_6843abffd2', plan: b.id })).isError, true);
    assert.equal((await call('get_evidence', { finding: 'bc_6843abffd2', plan: a.id })).isError, false);
    // An unknown plan id is an error naming the range plans held.
    const unknown = await call('get_finding', { id: 'bc_6843abffd2', plan: 'plan_nope' });
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, new RegExp(`Range plans held: ${b.id}`));
  });

  test('a refresh that finds no change clears the checkout plan instead of leaving the old one reachable', async () => {
    const { state, call } = await sequenceHarness();
    await call('plan_upgrade');
    assert.equal((await call('get_finding', { id: 'bc_6843abffd2' })).isError, false);
    state.none = true;
    const refreshed = await call('plan_upgrade', { refresh: true });
    assert.match(refreshed.text, /No dependency change found/);
    const stale = await call('get_finding', { id: 'bc_6843abffd2' });
    assert.equal(stale.isError, true);
    assert.match(stale.text, /Call plan_upgrade first/);
    assert.equal((await call('get_evidence', { finding: 'bc_6843abffd2' })).isError, true);
    // And a later plain call re-analyses rather than resurrecting it.
    state.none = false;
    const replanned = await call('plan_upgrade');
    assert.doesNotMatch(replanned.text, /Plan computed earlier/);
    assert.equal(state.calls, 3);
  });

  test('a refreshed explicit range replaces only that range', async () => {
    const { state, call } = await sequenceHarness();
    await call('plan_upgrade');
    await call('plan_upgrade', { before: 'x', after: 'y' });
    await call('plan_upgrade', { before: 'x', after: 'y' });
    assert.equal(state.calls, 2, 'the same range is reused');
    await call('plan_upgrade', { before: 'x', after: 'z' });
    assert.equal(state.calls, 3, 'a different range is a different plan');
    await call('plan_upgrade', { before: 'x', after: 'y', refresh: true });
    assert.equal(state.calls, 4);
    assert.match((await call('plan_upgrade')).text, /eslint 8\.57\.1/);
    assert.equal(state.calls, 4, 'the checkout plan was untouched throughout');
  });

  test('every JSON form over MCP stays within its ceiling', async () => {
    const { call } = await sequenceHarness();
    const brief = await call('plan_upgrade', { format: 'json' });
    assert.ok(Buffer.byteLength(brief.text) <= AGENT_BRIEF_BUDGET.maxTokens * BYTES_PER_TOKEN);
    const finding = await call('get_finding', { id: 'bc_a770541f05', format: 'json' });
    assert.ok(Buffer.byteLength(finding.text) <= 2_000 * BYTES_PER_TOKEN);
    const evidence = await call('get_evidence', { finding: 'bc_6843abffd2', format: 'json' });
    assert.ok(Buffer.byteLength(evidence.text) <= 2_500 * BYTES_PER_TOKEN);
  });
});
