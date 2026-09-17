import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommitUnit, RemediationPlan } from '../types.js';
import type { DriftConfig } from '../config/schema.js';
import type { FileSnapshot, FixAgent, FixOutcome, FixTask, RepairRequest, ScopeRequest } from '../agents/types.js';
import { isLockfile, isManifest, isProtectedPath, normalizePlanPath, validateAgentWorktree } from '../agents/scope.js';
import type { Logger } from '../util/logger.js';
import { execCommand, type Exec } from '../util/exec.js';
import { planForCommits } from './partition.js';
import { commitFiles } from './worktree-runner.js';
import type { RemediationVerifier, VerificationFailure, VerificationRun } from './verifier.js';

/**
 * Drift owns the fixing loop; a coding agent performs one bounded edit at a time.
 *
 * The alternative — handing an agent the whole upgrade and letting it plan,
 * edit, run the full build and test suite, read the logs, and go round again —
 * is where a remediation's tokens go. Every log it reads stays in its context
 * and is re-read on every later turn. This controller takes the parts of that
 * loop that need no model:
 *
 *   1. Work Drift already resolved deterministically (codemods, validated fix
 *      plans) happens before this runs and never reaches an agent.
 *   2. Units that cannot succeed are not dispatched: a unit whose every file
 *      is protected would be rejected by scope validation after the agent had
 *      already spent its tokens. Units that share a file set are one session.
 *   3. Each remaining unit is one fresh agent session, told what changed, where,
 *      and which files it may edit — and told not to run broad verification.
 *   4. Drift runs the project's checks itself. A pass ends the run.
 *   5. A failure becomes a repair request: the failures the upgrade introduced,
 *      grouped onto the unit whose files they name (or one residual unit for
 *      the rest), each handed to a new session with only that failure, the
 *      relevant migration facts, the edits already made, and its scope.
 *   6. The loop continues while repairs make progress and stops, with the
 *      reason recorded, when the same failure survives a round in which
 *      nothing changed, or survives two rounds that did change something.
 *
 * Every agent edit goes through the same validation as before — scope,
 * protected paths, secrets, test weakening — plus workaround detection and a
 * check that the upgraded dependency itself was not touched. A rejected edit
 * is reset, never kept.
 */

export type UnitOrigin = 'plan' | 'repair';

export type SessionStatus =
  | 'accepted'
  | 'no-change'
  | 'rejected'
  | 'agent-failed';

export interface ControllerSessionRecord {
  index: number;
  unitId: string;
  origin: UnitOrigin;
  /** 0 for the initial pass over plan units. */
  round: number;
  allowedFiles: string[];
  changedFiles: string[];
  status: SessionStatus;
  reasons: string[];
  scopeRequests: ScopeRequest[];
  /** Characters of prompt-relevant material handed over (diagnostics and repair text), not the rendered prompt. */
  failureChars: number;
  durationMs: number;
  sessionId?: string;
  message: string;
}

export interface ControllerVerificationRecord {
  round: number;
  passed: boolean;
  fingerprint: string;
  durationMs: number;
  installed: boolean;
  installFailure?: string;
  failures: number;
  preexisting: number;
  checks: { label: string; kind: string; status: string; durationMs: number; failures: number }[];
  sideEffectsReverted: string[];
}

export interface ControllerUnitRecord {
  id: string;
  origin: UnitOrigin;
  breakingChangeIds: string[];
  allowedFiles: string[];
  resolution: 'agent' | 'skipped-protected' | 'merged';
  mergedInto?: string;
}

export type ControllerTermination =
  | 'verified'
  | 'unverified'
  | 'no-progress'
  | 'repair-limit'
  | 'unrepairable'
  | 'aborted';

export interface ControllerRecord {
  planId: string;
  units: ControllerUnitRecord[];
  sessions: ControllerSessionRecord[];
  verifications: ControllerVerificationRecord[];
  termination: ControllerTermination;
  terminationDetail: string;
  agentSessions: number;
  repairRounds: number;
  outOfScopeRejections: number;
  workaroundRejections: number;
  grantedFiles: string[];
  deniedScopeRequests: ScopeRequest[];
  /** Units needing a human, e.g. a CI workflow Drift may not edit. */
  needsHuman: { unitId: string; files: string[]; reason: string }[];
  agentMs: number;
  verificationMs: number;
  totalMs: number;
}

export interface RemediationControllerOptions {
  /** Git working tree whose HEAD is the starting point. Edits are committed per accepted session. */
  root: string;
  plan: RemediationPlan;
  config: DriftConfig;
  agent: FixAgent;
  /** `null` when the project has no checks Drift can run; units then run once, unverified. */
  verifier: RemediationVerifier | null;
  logger: Logger;
  /** Units still needing an agent after the deterministic tiers. Defaults to every plan commit. */
  commits?: readonly CommitUnit[];
  exec?: Exec;
  /**
   * A ceiling on repair rounds, so a pathological case cannot run forever. It
   * is not the stopping rule — no progress is — and it defaults high enough
   * that a run making real progress does not reach it.
   */
  maxRepairRounds?: number;
  signal?: AbortSignal;
  /** Called before and after each agent session and verification, for callers that meter them. */
  onSessionStart?: (record: { index: number; unitId: string; origin: UnitOrigin; round: number }) => void;
  onSessionEnd?: (record: ControllerSessionRecord, outcome: FixOutcome | null) => void;
  onVerification?: (record: ControllerVerificationRecord, run: VerificationRun) => void;
}

const DEFAULT_MAX_REPAIR_ROUNDS = 10;
const MAX_FAILURES_SHOWN = 30;
const MAX_TAIL_LINES = 30;
const MAX_PREVIOUS_DIFF = 12_000;

interface AgentUnit {
  commit: CommitUnit;
  origin: UnitOrigin;
  /** The plan unit a repair descends from, for grant bookkeeping. */
  parentId?: string;
  failures?: VerificationFailure[];
}

export async function runRemediationController(options: RemediationControllerOptions): Promise<ControllerRecord> {
  const started = Date.now();
  const exec = options.exec ?? execCommand;
  const upgraded = [...new Set(options.plan.changes.map((change) => change.name))];
  const startRef = await head(options.root, exec);

  const record: ControllerRecord = {
    planId: options.plan.id,
    units: [],
    sessions: [],
    verifications: [],
    termination: 'unverified',
    terminationDetail: '',
    agentSessions: 0,
    repairRounds: 0,
    outOfScopeRejections: 0,
    workaroundRejections: 0,
    grantedFiles: [],
    deniedScopeRequests: [],
    needsHuman: [],
    agentMs: 0,
    verificationMs: 0,
    totalMs: 0,
  };

  const units = prepareAgentUnits(options.commits ?? options.plan.commits, record);
  const grants = new Map<string, Set<string>>();
  const changedSoFar = new Set<string>();

  const finish = (termination: ControllerTermination, detail: string): ControllerRecord => {
    record.termination = termination;
    record.terminationDetail = detail;
    record.totalMs = Date.now() - started;
    options.logger.info(`Remediation controller finished: ${termination}${detail ? ` — ${detail}` : ''}.`);
    return record;
  };

  const verify = async (round: number): Promise<VerificationRun> => {
    const run = await options.verifier!.run(options.signal ? { signal: options.signal } : {});
    await commitInstallChanges(options.root, exec);
    const verification: ControllerVerificationRecord = {
      round,
      passed: run.passed,
      fingerprint: run.fingerprint,
      durationMs: run.durationMs,
      installed: run.installed,
      ...(run.installFailure ? { installFailure: run.installFailure } : {}),
      failures: run.failures.length,
      preexisting: run.checks.reduce((sum, check) => sum + check.preexisting, 0),
      checks: run.checks.map((check) => ({ label: check.label, kind: check.kind, status: check.status, durationMs: check.durationMs, failures: check.failures.length })),
      sideEffectsReverted: run.sideEffectsReverted,
    };
    record.verifications.push(verification);
    record.verificationMs += run.durationMs;
    options.onVerification?.(verification, run);
    return run;
  };

  const runUnit = async (unit: AgentUnit, round: number, extras: { diagnostics?: string; repair?: RepairRequest }): Promise<ControllerSessionRecord> => {
    const index = record.sessions.length + 1;
    options.onSessionStart?.({ index, unitId: unit.commit.id, origin: unit.origin, round });
    const sessionStarted = Date.now();
    const baseline = await head(options.root, exec);
    const scopedPlan = planForCommits(options.plan, [unit.commit]);
    const task: FixTask = {
      plan: scopedPlan,
      commit: unit.commit,
      workspaceRoot: options.root,
      files: await snapshots(options.root, unit.commit.allowedFiles),
      customInstructions: options.config.remediation.customInstructions,
      model: options.config.remediation.agent.model ?? options.config.remediation.model,
      effort: options.config.remediation.agent.effort,
      fast: options.config.remediation.agent.fast,
      ...(options.verifier ? { verificationOwner: 'controller' as const } : {}),
      ...(extras.diagnostics ? { diagnostics: extras.diagnostics } : {}),
      ...(extras.repair ? { repair: extras.repair } : {}),
    };

    const dependencyWrites = options.verifier ? await options.verifier.watchDependencies() : null;
    let outcome: FixOutcome | null = null;
    const session: ControllerSessionRecord = {
      index,
      unitId: unit.commit.id,
      origin: unit.origin,
      round,
      allowedFiles: [...unit.commit.allowedFiles],
      changedFiles: [],
      status: 'agent-failed',
      reasons: [],
      scopeRequests: [],
      failureChars: (extras.diagnostics?.length ?? 0) + (extras.repair?.failures.length ?? 0) + (extras.repair?.previousDiff?.length ?? 0),
      durationMs: 0,
      message: '',
    };

    try {
      outcome = await options.agent.run(task, {
        report: (message) => options.logger.debug(message),
        signal: options.signal ?? new AbortController().signal,
      });
    } catch (err) {
      outcome = { status: 'failed', message: (err as Error).message };
    }

    const touchedDependency = dependencyWrites ? await dependencyWrites() : null;
    session.message = outcome.message.slice(0, 2000);
    session.scopeRequests = outcome.scopeRequests ?? [];
    if (outcome.sessionId) session.sessionId = outcome.sessionId;

    if (outcome.status === 'failed') {
      await reset(options.root, baseline, exec);
      session.reasons.push(outcome.message.slice(0, 500));
    } else {
      const validation = await validateAgentWorktree({
        root: options.root,
        baselineRef: baseline,
        commit: unit.commit,
        upgradedDependencies: upgraded,
      });
      session.changedFiles = [...new Set(validation.changed.flatMap((entry) => [entry.oldPath, entry.path].filter((path): path is string => Boolean(path))))];
      // Writing installed dependencies without declaring a dependency change
      // is patching the library, not migrating to it: invisible to git, and
      // gone on the next fresh install. An agent that ran an install for a
      // manifest change it made also writes there, legitimately.
      const declaredChange = session.changedFiles.some((file) => isManifest(file) || isLockfile(file));
      if (touchedDependency && !declaredChange) {
        validation.ok = false;
        validation.reasons.push(`Agent edited installed dependency files (${touchedDependency}) without changing a manifest; installed dependencies are not part of the fix and were reinstalled.`);
      }
      if (!validation.ok) {
        await reset(options.root, baseline, exec);
        session.status = 'rejected';
        session.reasons = validation.reasons;
        if (validation.reasons.some((reason) => /outside this unit's allowed files/.test(reason))) record.outOfScopeRejections += 1;
        if (validation.reasons.some((reason) => /coverage|relaxed|deleted test|skipped or todo|removed an assertion|upgraded dependency|installed dependency files/.test(reason))) {
          record.workaroundRejections += 1;
        }
      } else if (validation.changed.length === 0) {
        session.status = 'no-change';
      } else if (await commitFiles(options.root, session.changedFiles, `${unit.commit.message}\n\n${unit.commit.body}`, exec)) {
        session.status = 'accepted';
        for (const file of session.changedFiles) changedSoFar.add(file);
      } else {
        await reset(options.root, baseline, exec);
        session.status = 'rejected';
        session.reasons.push('Could not commit the accepted edits.');
      }
    }

    if (touchedDependency && options.verifier) {
      session.reasons.push(`installed dependencies were written during the session (${touchedDependency}); reinstalled from the manifests`);
      const failure = await options.verifier.reinstallClean();
      if (failure) session.reasons.push(`reinstall: ${failure.slice(0, 300)}`);
    }

    // A request is only ever a request. It is granted to the unit that asked,
    // for its next session, when the path is one an agent may edit at all.
    for (const request of session.scopeRequests) {
      const path = normalizePlanPath(request.path);
      const owner = unit.parentId ?? unit.commit.id;
      if (!path || isProtectedPath(path)) {
        record.deniedScopeRequests.push(request);
        continue;
      }
      if (!grants.has(owner)) grants.set(owner, new Set());
      grants.get(owner)!.add(path);
      if (!record.grantedFiles.includes(path)) record.grantedFiles.push(path);
    }

    session.durationMs = Date.now() - sessionStarted;
    record.agentMs += session.durationMs;
    record.sessions.push(session);
    record.agentSessions += 1;
    options.onSessionEnd?.(session, outcome);
    return session;
  };

  // Measured first: it scopes the initial sessions' diagnostics, and a
  // repository that already passes with nothing for an agent to do is done.
  let current = options.verifier ? await verify(0) : null;
  if (current?.passed && units.length === 0) return finish('verified', 'the checks pass and no unit needed an agent');

  for (const unit of units) {
    if (options.signal?.aborted) return finish('aborted', 'cancelled');
    const failures = current ? current.failures.filter((failure) => failure.file && unit.commit.allowedFiles.includes(failure.file)) : [];
    await runUnit(unit, 0, failures.length ? { diagnostics: renderFailures(failures, current!, { unitFiles: unit.commit.allowedFiles }) } : {});
  }

  if (!options.verifier) {
    return finish('unverified', 'no checks were available to verify the result');
  }

  const maxRounds = options.maxRepairRounds ?? DEFAULT_MAX_REPAIR_ROUNDS;
  let previousFingerprint: string | null = null;
  let stalledRounds = 0;
  let round = 0;

  // Nothing an agent did since the initial measurement means nothing to
  // re-measure: every planned unit was skipped, or none existed.
  let sessionsAtLastVerification = record.sessions.length === 0 ? 0 : -1;

  for (;;) {
    if (options.signal?.aborted) return finish('aborted', 'cancelled');
    if (!(current && sessionsAtLastVerification === record.sessions.length)) current = await verify(round + 1);
    sessionsAtLastVerification = record.sessions.length;
    if (current.passed) return finish('verified', round === 0 ? 'the checks pass after the planned units' : `the checks pass after ${round} repair round(s)`);

    if (previousFingerprint !== null && current.fingerprint === previousFingerprint) {
      const lastRound = record.sessions.filter((session) => session.round === round);
      const changedSomething = lastRound.some((session) => session.status === 'accepted');
      const grantedSomething = lastRound.some((session) => session.scopeRequests.some((request) => record.grantedFiles.includes(normalizePlanPath(request.path))));
      stalledRounds += 1;
      if ((!changedSomething && !grantedSomething) || stalledRounds >= 2) {
        return finish('no-progress', `the same ${current.failures.length} failure(s) remained after ${changedSomething ? 'two rounds of edits' : 'a round that changed nothing'}`);
      }
    } else {
      stalledRounds = 0;
    }

    if (round >= maxRounds) return finish('repair-limit', `${current.failures.length} failure(s) remain after ${round} repair rounds`);

    const repairs = planRepairs(current, units, grants, changedSoFar, options.plan, (path) => existsSync(join(options.root, path)));
    if (repairs.length === 0) return finish('unrepairable', 'the remaining failures name nothing an agent is allowed to edit');

    previousFingerprint = current.fingerprint;
    round += 1;
    record.repairRounds = round;
    for (const repair of repairs) {
      if (options.signal?.aborted) return finish('aborted', 'cancelled');
      const previousDiff = await diffSince(options.root, startRef, repair.commit.allowedFiles, exec);
      await runUnit(repair, round, {
        repair: {
          round,
          failures: renderFailures(repair.failures ?? [], current, { unitFiles: repair.commit.allowedFiles, includeTails: repair.parentId === RESIDUAL_ID }),
          ...(previousDiff ? { previousDiff } : {}),
        },
      });
    }
  }
}

/**
 * The units worth an agent session.
 *
 * A unit whose every file is protected is recorded as needing a human and
 * never dispatched: validation would reject any edit it made. Units with the
 * same allowed-file set are merged, because two sessions over the same files
 * pay twice for reading them and can undo each other.
 */
export function prepareAgentUnits(commits: readonly CommitUnit[], record: Pick<ControllerRecord, 'units' | 'needsHuman'>): AgentUnit[] {
  const bySet = new Map<string, AgentUnit>();
  for (const commit of commits) {
    const allowed = [...new Set((commit.allowedFiles?.length ? commit.allowedFiles : commit.files).map(normalizePlanPath).filter(Boolean))].sort();
    const editable = allowed.filter((file) => !isProtectedPath(file));
    if (editable.length === 0) {
      record.units.push({ id: commit.id, origin: 'plan', breakingChangeIds: commit.breakingChangeIds, allowedFiles: allowed, resolution: 'skipped-protected' });
      record.needsHuman.push({ unitId: commit.id, files: allowed, reason: 'every file this unit would change is protected from agent edits' });
      continue;
    }
    const key = editable.join('\n');
    const existing = bySet.get(key);
    if (existing) {
      existing.commit = mergeCommits(existing.commit, commit);
      record.units.push({ id: commit.id, origin: 'plan', breakingChangeIds: commit.breakingChangeIds, allowedFiles: editable, resolution: 'merged', mergedInto: existing.commit.id });
      continue;
    }
    bySet.set(key, { commit: { ...commit, allowedFiles: editable, files: editable }, origin: 'plan' });
    record.units.push({ id: commit.id, origin: 'plan', breakingChangeIds: commit.breakingChangeIds, allowedFiles: editable, resolution: 'agent' });
  }
  return [...bySet.values()];
}

export const RESIDUAL_ID = 'residual';

/**
 * Turn a failed verification into repair units.
 *
 * A failure naming a file inside a plan unit's scope goes to a repair of that
 * unit, with that unit's migration facts. Everything else — failures in files
 * no unit owns, failures that name no file at all — goes to one residual
 * repair, scoped to the files the failures and the check output name plus the
 * files already edited, with only the findings whose symbols the failures
 * mention. Files granted through scope requests join the scope of the unit
 * that asked.
 */
export function planRepairs(
  run: VerificationRun,
  units: readonly AgentUnit[],
  grants: ReadonlyMap<string, ReadonlySet<string>>,
  changedSoFar: ReadonlySet<string>,
  plan: RemediationPlan,
  /**
   * Whether a path is a real file in the repository. Paths read out of check
   * output are only candidates: a stack frame, a package name or a sentence
   * fragment parses as a path often enough to put `Node.js` or
   * `at runRuleForItem (/tmp/...` into a repair's scope. Files the agent
   * already changed and files it requested may not exist yet and are exempt.
   */
  exists: (path: string) => boolean = () => true,
): AgentUnit[] {
  const repairs: AgentUnit[] = [];
  const unowned: VerificationFailure[] = [];
  const byUnit = new Map<string, VerificationFailure[]>();

  for (const failure of run.failures) {
    const owner = failure.file ? units.find((unit) => unit.commit.allowedFiles.includes(failure.file!)) : undefined;
    if (!owner) {
      unowned.push(failure);
      continue;
    }
    if (!byUnit.has(owner.commit.id)) byUnit.set(owner.commit.id, []);
    byUnit.get(owner.commit.id)!.push(failure);
  }

  for (const unit of units) {
    const failures = byUnit.get(unit.commit.id);
    const granted = [...(grants.get(unit.commit.id) ?? [])];
    if (!failures?.length && granted.length === 0) continue;
    const allowed = withLockfiles([...new Set([...unit.commit.allowedFiles, ...granted])]);
    repairs.push({
      commit: {
        ...unit.commit,
        id: `${unit.commit.id}-repair`,
        allowedFiles: allowed,
        files: allowed,
        instructions: 'Fix the failures listed under "What still fails" that fall within this unit. Earlier edits are already applied.',
      },
      origin: 'repair',
      parentId: unit.commit.id,
      failures: failures ?? [],
    });
  }

  const residualGrants = [...(grants.get(RESIDUAL_ID) ?? [])];
  if (unowned.length > 0 || residualGrants.length > 0) {
    const failingChecks = new Set(unowned.map((failure) => failure.check));
    const named = unowned.map((failure) => failure.file).filter((file): file is string => Boolean(file));
    const mentioned = run.checks.filter((check) => failingChecks.has(check.label)).flatMap((check) => check.mentionedFiles);
    const measured = [...named, ...mentioned].map(normalizePlanPath).filter((file) => file && !/\s/.test(file) && exists(file));
    const candidates = [...measured, ...[...changedSoFar, ...residualGrants].map(normalizePlanPath)]
      .filter((file) => file && !isProtectedPath(file) && !isLockfile(file));
    const allowed = withLockfiles([...new Set(candidates)].sort().slice(0, 25));
    // No editable file named is not the same as nothing to do: a type error
    // inside an installed dependency's declarations is fixed in this
    // repository's tsconfig, and no check output names that file. The session
    // gets no files and is asked which ones it needs; the next round grants them.
    const scopeless = allowed.length === 0;
    {
      const text = unowned.map((failure) => failure.message).join('\n');
      const relevant = plan.breakingChanges.filter((change) => change.symbols.some((symbol) => symbol.length > 2 && text.includes(symbol.split('.').pop()!))).slice(0, 3);
      repairs.push({
        commit: {
          id: RESIDUAL_ID,
          order: 0,
          message: `fix(deps): resolve remaining failures after upgrading ${plan.changes.map((change) => change.name).join(', ')}`,
          body: 'Failures Drift measured after the planned edits that no planned unit owned.',
          breakingChangeIds: relevant.map((change) => change.id),
          files: allowed,
          allowedFiles: allowed,
          instructions: scopeless
            ? 'The failures listed under "What still fails" name no file in this repository that may be edited — they point at installed dependencies, tooling, or nothing at all. ' +
              'Do not edit anything in this session. Work out which file(s) in this repository must change to resolve them (configuration included) and request each one with a scope request line; ' +
              'the next session will be allowed to edit what you request. Never request a path inside installed dependencies.'
            : 'Fix the failures listed under "What still fails". They were measured after the planned edits and are not attributed to any planned unit. ' +
              'If one needs a file outside your scope, request it rather than editing it.',
          dependsOn: [],
          dependencyReasons: [],
          executionLayer: 0,
          expectedChecks: [],
          invalidationTriggers: [],
        },
        origin: 'repair',
        parentId: RESIDUAL_ID,
        failures: unowned,
      });
    }
  }

  return repairs;
}

/**
 * Failures as prompt text: grouped by check, bounded, and stating what was
 * left out. Failures on the unit's own files come first.
 */
export function renderFailures(
  failures: readonly VerificationFailure[],
  run: VerificationRun,
  options: { unitFiles: readonly string[]; includeTails?: boolean },
): string {
  const lines: string[] = [];
  const byCheck = new Map<string, VerificationFailure[]>();
  for (const failure of failures) {
    if (!byCheck.has(failure.check)) byCheck.set(failure.check, []);
    byCheck.get(failure.check)!.push(failure);
  }

  for (const [check, group] of byCheck) {
    const result = run.checks.find((candidate) => candidate.label === check);
    const ranked = [...group].sort((a, b) => Number(Boolean(b.file && options.unitFiles.includes(b.file))) - Number(Boolean(a.file && options.unitFiles.includes(a.file))));
    lines.push(`### \`${check}\` — ${group.length} failure${group.length === 1 ? '' : 's'} introduced by the upgrade`);
    if (result?.preexisting) lines.push(`(${result.preexisting} other failure${result.preexisting === 1 ? '' : 's'} in this check already happened before the upgrade and are not listed.)`);
    lines.push('');
    for (const failure of ranked.slice(0, MAX_FAILURES_SHOWN)) lines.push(`- ${failure.message}`);
    if (ranked.length > MAX_FAILURES_SHOWN) lines.push(`- …and ${ranked.length - MAX_FAILURES_SHOWN} more of the same check.`);
    const opaque = group.every((failure) => !failure.file);
    if (result && (options.includeTails || opaque) && result.tail) {
      lines.push('', 'End of its output:', '```', result.tail.split('\n').slice(-MAX_TAIL_LINES).join('\n'), '```');
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

function mergeCommits(a: CommitUnit, b: CommitUnit): CommitUnit {
  return {
    ...a,
    breakingChangeIds: [...new Set([...a.breakingChangeIds, ...b.breakingChangeIds])],
    body: `${a.body}\n\n${b.body}`,
    instructions: `${a.instructions}\n\n${b.instructions}`,
    allowedSymbols: [...new Set([...(a.allowedSymbols ?? []), ...(b.allowedSymbols ?? [])])],
  };
}

/** A granted manifest brings its lockfiles: the install Drift runs will rewrite them. */
function withLockfiles(files: readonly string[]): string[] {
  const out = new Set(files);
  for (const file of files) {
    if (!isManifest(file) || !file.endsWith('package.json')) continue;
    const dir = file.includes('/') ? `${file.slice(0, file.lastIndexOf('/'))}/` : '';
    for (const lock of ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json', 'bun.lock']) out.add(`${dir}${lock}`);
  }
  return [...out];
}

async function snapshots(root: string, files: readonly string[]): Promise<FileSnapshot[]> {
  const out: FileSnapshot[] = [];
  for (const path of files) {
    try {
      out.push({ path, content: await readFile(join(root, path), 'utf8') });
    } catch {
      // A file the unit may create does not exist yet.
    }
  }
  return out;
}

async function head(root: string, exec: Exec): Promise<string> {
  const result = await exec('git', ['rev-parse', 'HEAD'], { cwd: root });
  if (result.code !== 0) throw new Error(`Could not read HEAD in ${root}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

async function reset(root: string, ref: string, exec: Exec): Promise<void> {
  await exec('git', ['reset', '--hard', ref], { cwd: root });
  await exec('git', ['clean', '-fd'], { cwd: root });
}

async function diffSince(root: string, ref: string, files: readonly string[], exec: Exec): Promise<string> {
  const paths = files.filter((file) => !isLockfile(file));
  if (paths.length === 0) return '';
  const result = await exec('git', ['diff', ref, 'HEAD', '--', ...paths], { cwd: root });
  const text = result.stdout.trim();
  return text.length > MAX_PREVIOUS_DIFF ? `${text.slice(0, MAX_PREVIOUS_DIFF)}\n… (diff truncated)` : text;
}

/**
 * An install the verifier ran after a manifest changed rewrites lockfiles.
 * Those are committed here, by the controller, so the next agent session starts
 * from a clean tree and its validation does not attribute them to the agent.
 */
async function commitInstallChanges(root: string, exec: Exec): Promise<void> {
  const status = await exec('git', ['status', '--porcelain=v1', '-z'], { cwd: root });
  const paths = status.stdout
    .split('\0')
    .filter(Boolean)
    .map((entry) => entry.slice(3))
    .filter((path) => isLockfile(path));
  if (paths.length === 0) return;
  await commitFiles(root, paths, 'chore(deps): sync lockfile after a companion dependency change', exec);
}
