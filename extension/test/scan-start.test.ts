import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { DriftConfigSchema } from '../../src/config/schema.js';
import { DriftSession, type ThreadItem } from '../src/session.js';
import { DriftState } from '../src/state.js';
import { DriftReview } from '../src/review/store.js';
import { DriftHomeView } from '../src/ui/home.js';
import { OperationGate } from '../src/ui/scan-start.js';
import { __settings } from './vscode-stub.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class MemoryMemento implements vscode.Memento {
  private readonly values = new Map<string, unknown>();
  readonly keys = () => [...this.values.keys()];
  get<T>(key: string, fallback?: T): T {
    return (this.values.has(key) ? this.values.get(key) : fallback) as T;
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value);
  }
}

function output(): vscode.LogOutputChannel {
  return {
    name: 'Drift Test',
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    append: () => undefined,
    appendLine: () => undefined,
    replace: () => undefined,
    clear: () => undefined,
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
    logLevel: 2,
    onDidChangeLogLevel: () => ({ dispose: () => undefined }),
  } as unknown as vscode.LogOutputChannel;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail('timed out waiting for condition');
}

function questions(session: DriftSession): Extract<ThreadItem, { kind: 'question' }>[] {
  return session.snapshot().filter((item): item is Extract<ThreadItem, { kind: 'question' }> => item.kind === 'question');
}

function steps(session: DriftSession): Extract<ThreadItem, { kind: 'step' }>[] {
  return session.snapshot().filter((item): item is Extract<ThreadItem, { kind: 'step' }> => item.kind === 'step');
}

test('operation gate allows one pending choice phase at a time', async () => {
  const gate = new OperationGate();
  const first = deferred();
  let starts = 0;

  const running = gate.run(async () => {
    starts += 1;
    await first.promise;
  });

  assert.equal(gate.active, true);
  assert.equal(await gate.run(async () => {
    starts += 1;
  }), 'busy');
  assert.equal(starts, 1);

  first.resolve();
  assert.equal(await running, 'started');
  assert.equal(gate.active, false);

  assert.equal(await gate.run(async () => {
    starts += 1;
  }), 'started');
  assert.equal(starts, 2);
});

test('a pending scan choice blocks competing operations until the scan enters run', async () => {
  __settings.clear();
  __settings.set('analysis.verifyMode', 'ask');
  __settings.set('analysis.dependencyScope', 'ask');

  const root = '/tmp/drift-scan-race';
  const session = new DriftSession();
  const state = new DriftState();
  state.setRepo(null, root);
  state.setCandidates([
    {
      id: 'left-pad@1.0.0->1.1.0',
      name: 'left-pad',
      kind: 'runtime',
      ecosystem: 'npm',
      packageManager: 'npm',
      manifestPath: 'package.json',
      current: '1.0.0',
      range: '^1.0.0',
      safeLatest: '1.1.0',
      selected: '1.1.0',
      latest: '1.1.0',
      versions: ['1.1.0'],
      status: 'ready',
      evidenceCount: 0,
      breakingCount: 0,
      impactCount: 0,
      impactFiles: 0,
      impactConfidence: 'high',
      risk: 'none',
      gaps: [],
      toolRequests: [],
      summary: 'Existing candidate that must not be cleared before the scan actually runs.',
    },
  ]);

  const home = new DriftHomeView(
    vscode.Uri.file('/tmp/drift-test'),
    state,
    session,
    new DriftReview(),
    output(),
    new MemoryMemento(),
  );
  const controller = home as unknown as {
    contextFor(root: string): Promise<unknown>;
    resolveManagers(root: string): Promise<null>;
    run(work: (token: vscode.CancellationToken) => Promise<void>): Promise<void>;
    scanned: boolean;
  };

  controller.contextFor = async () => ({
    root,
    info: null,
    repo: {
      owner: 'local',
      repo: 'drift-scan-race',
      baseBranch: 'working-tree',
      beforeSha: 'WORKING_TREE',
      afterSha: 'WORKING_TREE',
      workspace: root,
    },
    config: DriftConfigSchema.parse({}),
  });
  controller.resolveManagers = async () => null;

  const scan = home.scanOnStartup();
  await waitFor(() => questions(session).length === 1);

  assert.equal(controller.scanned, false);
  assert.equal(state.candidates.length, 1);

  let competingRan = false;
  await controller.run(async () => {
    competingRan = true;
  });

  assert.equal(competingRan, false);
  assert.equal(controller.scanned, false);
  assert.equal(state.candidates.length, 1);
  assert.equal(questions(session).length, 1);

  const [question] = questions(session);
  assert.ok(question);
  session.answer(question.id, 'quick:runtime');
  await scan;

  assert.equal(competingRan, false);
  assert.equal(controller.scanned, true);
  assert.equal(state.candidates.length, 0);

  const scanSteps = steps(session).filter((item) => /Checking your dependencies/.test(item.title));
  assert.equal(scanSteps.length, 1);
  assert.equal(scanSteps[0]!.state, 'done');
});
