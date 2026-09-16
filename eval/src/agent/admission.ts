import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { caseDir, hashCase, loadCase, loadHidden, loadSuite, suitesRoot, validateCaseShape } from './cases.ts';
import type { AgentCase, HiddenMaterial, SuiteManifest } from './schema.ts';
import { driftRevision } from './store.ts';
import { patchStatsFrom, validateWorkspace } from './validation.ts';
import { applyPatch, captureDiff, materializeWorkspace, projectEnv, runCommand, type Workspace } from './workspace.ts';

/**
 * Case admission: the checks a case passes before it may enter a suite.
 *
 *   1. shape        the case and its hidden half parse and are internally consistent
 *   2. start state  materializes and installs on this machine
 *   3. broken       at the start state, at least one hidden test FAILS
 *                   (a hidden test that already passes proves nothing)
 *   4. fixed        with the reference patch applied: install succeeds, the
 *                   dependency is still at the new version, every project
 *                   check passes, every hidden test passes, no forbidden rule
 *                   fires
 *   5. determinism  step 4 repeated `repeats` times gives identical results
 *   6. isolation    the materialized workspace audits clean (done by
 *                   materialization itself; a failure throws)
 *
 * Every step's evidence is written to `eval/agent/cases/<id>/admission.json`
 * and a passing case is (with `--write`) recorded in the suite manifest with
 * its content hash.
 */

export interface AdmissionStep {
  step: string;
  passed: boolean;
  detail: string;
}

export interface AdmissionResult {
  caseId: string;
  caseHash: string;
  admitted: boolean;
  steps: AdmissionStep[];
  checkedAt: string;
  driftCommit: string;
  /** Names the hidden tests that fail at the start state, which is what makes the case a case. */
  failingHiddenTestsAtStart: string[];
  /** Whether the project's own checks fail at the start state; informational. */
  projectChecksFailAtStart: boolean | null;
}

export interface AdmissionOptions {
  repeats?: number;
  root?: string;
  onProgress?: (message: string) => void;
}

export async function admitCase(caseId: string, options: AdmissionOptions = {}): Promise<AdmissionResult> {
  const root = options.root ?? process.cwd();
  const repeats = options.repeats ?? 2;
  const steps: AdmissionStep[] = [];
  const revision = await driftRevision(root);
  const checkedAt = new Date().toISOString();
  let failingHiddenTestsAtStart: string[] = [];
  let projectChecksFailAtStart: boolean | null = null;

  let agentCase: AgentCase;
  let hidden: HiddenMaterial;
  try {
    agentCase = await loadCase(caseId, root);
    hidden = await loadHidden(caseId, root);
    const problems = validateCaseShape(agentCase);
    steps.push({ step: 'shape', passed: problems.length === 0, detail: problems.join('; ') });
    if (problems.length > 0) return finish(caseId, await hashCase(caseId, root), steps, checkedAt, revision.commit, failingHiddenTestsAtStart, projectChecksFailAtStart, root);
  } catch (err) {
    steps.push({ step: 'shape', passed: false, detail: (err as Error).message });
    return finish(caseId, 'unavailable', steps, checkedAt, revision.commit, failingHiddenTestsAtStart, projectChecksFailAtStart, root);
  }
  const caseHash = await hashCase(caseId, root);

  // 3. Broken start state.
  options.onProgress?.(`${caseId}: start state`);
  const broken = await stateOf(agentCase, hidden, null, options);
  if (broken.setupFailure) {
    steps.push({ step: 'start-state', passed: false, detail: broken.setupFailure });
    return finish(caseId, caseHash, steps, checkedAt, revision.commit, failingHiddenTestsAtStart, projectChecksFailAtStart, root);
  }
  steps.push({ step: 'start-state', passed: true, detail: 'materialized and installed' });
  failingHiddenTestsAtStart = broken.validation!.hiddenTests.filter((test) => !test.passed).map((test) => test.id);
  projectChecksFailAtStart = broken.validation!.checks.some((check) => !check.passed);
  steps.push({
    step: 'broken-state-hidden-tests-fail',
    passed: failingHiddenTestsAtStart.length > 0 && broken.unableToRun.length === 0,
    detail:
      broken.unableToRun.length > 0
        ? `could not run: ${broken.unableToRun.join('; ')}`
        : failingHiddenTestsAtStart.length > 0
          ? `failing at start: ${failingHiddenTestsAtStart.join(', ')} (project checks ${projectChecksFailAtStart ? 'also fail' : 'pass'})`
          : 'every hidden test already passes at the start state; the case exercises nothing',
  });
  steps.push({
    step: 'broken-state-dependency-upgraded',
    passed: broken.validation!.dependencyIntegrity.passed,
    detail: broken.validation!.dependencyIntegrity.details.join('; ') || `installed ${broken.validation!.dependencyIntegrity.installedVersion}`,
  });

  // 4 + 5. Fixed state, repeated.
  const signatures: string[] = [];
  for (let attempt = 1; attempt <= repeats; attempt += 1) {
    options.onProgress?.(`${caseId}: reference fix (${attempt}/${repeats})`);
    const fixed = await stateOf(agentCase, hidden, hidden.referencePatch, options);
    if (fixed.setupFailure) {
      steps.push({ step: `fixed-state-${attempt}`, passed: false, detail: fixed.setupFailure });
      signatures.push('setup-failure');
      continue;
    }
    const v = fixed.validation!;
    const signature = JSON.stringify({
      success: v.success,
      integrity: v.dependencyIntegrity.passed,
      checks: v.checks.map((c) => [c.name, c.passed]),
      hidden: v.hiddenTests.map((t) => [t.id, t.passed]),
      forbidden: v.forbidden.map((f) => [f.kind, f.passed]),
    });
    signatures.push(signature);
    const problems = [
      ...(fixed.unableToRun.length > 0 ? [`could not run: ${fixed.unableToRun.join('; ')}`] : []),
      ...(v.dependencyIntegrity.passed ? [] : [`dependency integrity: ${v.dependencyIntegrity.details.join('; ')}`]),
      ...v.checks.filter((c) => !c.passed).map((c) => `check ${c.name} failed`),
      ...v.hiddenTests.filter((t) => !t.passed).map((t) => `hidden ${t.id} failed: ${t.outputExcerpt.slice(0, 300)}`),
      ...v.forbidden.filter((f) => !f.passed).map((f) => `rule ${f.kind} fired: ${f.detail}`),
    ];
    steps.push({ step: `fixed-state-${attempt}`, passed: v.success && fixed.unableToRun.length === 0, detail: problems.join('; ') || 'reference fix passes every layer' });
  }
  steps.push({
    step: 'deterministic',
    passed: signatures.length === repeats && new Set(signatures).size === 1,
    detail: new Set(signatures).size === 1 ? `${repeats} identical validation outcomes` : `outcomes differed across ${repeats} runs`,
  });

  return finish(caseId, caseHash, steps, checkedAt, revision.commit, failingHiddenTestsAtStart, projectChecksFailAtStart, root);
}

async function finish(
  caseId: string,
  caseHash: string,
  steps: AdmissionStep[],
  checkedAt: string,
  driftCommit: string,
  failingHiddenTestsAtStart: string[],
  projectChecksFailAtStart: boolean | null,
  root: string,
): Promise<AdmissionResult> {
  const result: AdmissionResult = {
    caseId,
    caseHash,
    admitted: steps.length > 0 && steps.every((step) => step.passed),
    steps,
    checkedAt,
    driftCommit,
    failingHiddenTestsAtStart,
    projectChecksFailAtStart,
  };
  if (caseHash !== 'unavailable') {
    await writeFile(join(caseDir(caseId, root), 'admission.json'), `${JSON.stringify({ ...result, caseHash: undefined }, null, 2)}\n`, 'utf8');
    // The hash covers everything in the case directory, so it is recomputed
    // after the admission record is written and stored in the suite manifest.
    result.caseHash = await hashCase(caseId, root);
  }
  return result;
}

interface StateOutcome {
  setupFailure: string | null;
  validation: Awaited<ReturnType<typeof validateWorkspace>>['result'] | null;
  unableToRun: string[];
}

async function stateOf(agentCase: AgentCase, hidden: HiddenMaterial, patch: string | null, options: AdmissionOptions): Promise<StateOutcome> {
  let workspace: Workspace | null = null;
  try {
    workspace = await materializeWorkspace(agentCase, options.root);
    const install = await runCommand(agentCase.commands.install, {
      cwd: workspace.project,
      timeoutMs: agentCase.commands.installTimeoutSeconds * 1000,
      env: projectEnv(agentCase),
    });
    if (install.spawnFailed || install.timedOut || install.code !== 0) {
      return { setupFailure: `install failed (exit ${install.code}): ${install.output.slice(-1500)}`, validation: null, unableToRun: [] };
    }
    if (patch) {
      try {
        await applyPatch(workspace.repo, patch);
      } catch (err) {
        return { setupFailure: `reference patch does not apply: ${(err as Error).message}`, validation: null, unableToRun: [] };
      }
    }
    const captured = await captureDiff(workspace.repo, workspace.startCommit);
    const stats = patchStatsFrom(captured.nameStatus, captured.numstat);
    const { result, unableToRun } = await validateWorkspace({
      agentCase,
      workspace,
      hidden,
      agentStatus: 'completed',
      diff: captured.diff,
      patch: stats,
      onProgress: options.onProgress ? (message) => options.onProgress!(`  ${message}`) : undefined,
    });
    return { setupFailure: null, validation: result, unableToRun };
  } catch (err) {
    return { setupFailure: (err as Error).message, validation: null, unableToRun: [] };
  } finally {
    if (workspace) await workspace.teardown().catch(() => undefined);
  }
}

/** Records admitted cases in a draft suite. Refuses to touch a frozen suite. */
export async function recordAdmissions(suite: string, results: readonly AdmissionResult[], root = process.cwd()): Promise<SuiteManifest> {
  const path = join(suitesRoot(root), `${suite}.json`);
  let manifest: SuiteManifest;
  try {
    manifest = await loadSuite(suite, root);
  } catch {
    manifest = { suite, status: 'draft', description: '', frozenAt: null, runsPerCondition: 5, cases: [], removed: [] };
  }
  if (manifest.status === 'frozen') throw new Error(`Suite ${suite} is frozen. Create a new suite version instead of changing it.`);
  for (const result of results) {
    if (!result.admitted) continue;
    const entry = { id: result.caseId, caseHash: result.caseHash, admittedAt: result.checkedAt, driftCommit: result.driftCommit };
    const index = manifest.cases.findIndex((c) => c.id === result.caseId);
    if (index >= 0) manifest.cases[index] = entry;
    else manifest.cases.push(entry);
  }
  manifest.cases.sort((a, b) => a.id.localeCompare(b.id));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

export async function readAdmission(caseId: string, root = process.cwd()): Promise<AdmissionResult | null> {
  try {
    return JSON.parse(await readFile(join(caseDir(caseId, root), 'admission.json'), 'utf8')) as AdmissionResult;
  } catch {
    return null;
  }
}

export { rm as removeDir };
