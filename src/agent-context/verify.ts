import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { availableChecks, runChecks, type CheckOutcome } from '../verification/checks.js';
import { parseVerificationDiagnostics } from '../verification/diagnostics.js';
import type { DependencyChange } from '../types.js';
import { VERIFICATION_BUDGET, byteLength, capLine, clipLines, estimateTokens, maxBytes, type ContextBudget } from './budget.js';

/**
 * Run this project's own checks against the working tree as it is now, and
 * report the result in a few hundred tokens.
 *
 * This is the agent's question after editing — "does it pass now?" — not Deep
 * Verification's "did the upgrade alone break it?", which installs the change
 * in a scratch worktree. Here nothing is installed and nothing is copied: the
 * project's commands run in the directory the agent is editing, exactly as
 * the agent would run them itself.
 *
 * What comes back is bounded: a status per check, the first parsed compiler
 * diagnostics, and a short tail when nothing parsed. The full output of every
 * check is written to a temporary file whose path is returned, so a long log
 * is one read away rather than in the model's context.
 */

export interface WorkingTreeCheckRequest {
  directory: string;
  /** Run only checks whose label contains one of these (e.g. `test`, `npm run build`). Default: every detected check. */
  only?: readonly string[];
  timeoutMs?: number;
  /** The plan's dependency changes, to confirm the upgrade is still declared. */
  changes?: readonly DependencyChange[];
  budget?: ContextBudget;
}

export interface AgentCheckResult {
  label: string;
  kind: string;
  status: CheckOutcome['status'];
  durationMs: number;
  diagnostics: { file: string; line: number; message: string }[];
  diagnosticsTotal: number;
  excerpt?: string;
  reason?: string;
  logPath: string | null;
}

export interface WorkingTreeCheckReport {
  text: string;
  bytes: number;
  estimatedTokens: number;
  passed: boolean;
  checks: AgentCheckResult[];
  declared: { dependency: string; manifestPath: string; target: string | null; declared: string | null }[];
}

const DIAGNOSTICS_PER_CHECK = 8;
const TAIL_LINES = 12;

export async function runWorkingTreeChecks(request: WorkingTreeCheckRequest): Promise<WorkingTreeCheckReport> {
  const root = resolve(request.directory);
  const budget = request.budget ?? VERIFICATION_BUDGET;
  const detected = await availableChecks(root);
  const selected = request.only?.length
    ? detected.filter((check) => request.only!.some((wanted) => check.label.includes(wanted)))
    : detected;

  const outcomes = selected.length > 0 ? await runChecks({ root, checks: selected, timeoutMs: request.timeoutMs ?? 10 * 60_000 }) : [];
  const logDir = outcomes.length > 0 ? await mkdtemp(join(tmpdir(), 'drift-checks-')) : null;

  const checks: AgentCheckResult[] = [];
  for (const outcome of outcomes) {
    const output = outcome.fullOutput ?? outcome.output;
    let logPath: string | null = null;
    if (logDir && output) {
      logPath = join(logDir, `${outcome.label.replace(/[^\w.-]+/g, '_')}.log`);
      await writeFile(logPath, output);
    }
    const parsed =
      outcome.status === 'failed'
        ? parseVerificationDiagnostics(output, root).filter(
            (d) => d.severity === 'error' && !/(^|\/)node_modules\//.test(d.file) && !d.file.startsWith('/'),
          )
        : [];
    const tail =
      outcome.status === 'failed' && parsed.length === 0
        ? output.split('\n').filter((line) => line.trim()).slice(-TAIL_LINES).map((line) => capLine(line, 200)).join('\n')
        : undefined;
    checks.push({
      label: outcome.label,
      kind: outcome.kind,
      status: outcome.status,
      durationMs: outcome.durationMs,
      diagnostics: parsed.slice(0, DIAGNOSTICS_PER_CHECK).map((d) => ({
        file: d.file,
        line: d.line,
        message: capLine(`${d.code ? `${d.code}: ` : ''}${d.message}`, 160),
      })),
      diagnosticsTotal: parsed.length,
      ...(tail ? { excerpt: tail } : {}),
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      logPath,
    });
  }

  const declared = await declaredVersions(root, request.changes ?? []);
  const passed = checks.length > 0 && checks.every((check) => check.status === 'passed');

  const lines: string[] = [];
  if (checks.length === 0) {
    lines.push(
      selected.length === 0 && detected.length > 0
        ? `No detected check matched ${request.only!.join(', ')}. Detected: ${detected.map((c) => c.label).join(', ')}.`
        : 'Drift found no build, typecheck or test command for this directory. Run the project’s own checks directly.',
    );
  }
  for (const check of checks) {
    lines.push(`${check.status === 'passed' ? 'PASS' : check.status === 'failed' ? 'FAIL' : check.status.toUpperCase()} ${check.label} (${Math.round(check.durationMs / 1000)}s)${check.reason ? ` — ${capLine(check.reason, 160)}` : ''}`);
    for (const d of check.diagnostics) lines.push(`  ${d.file}:${d.line} ${d.message}`);
    if (check.diagnosticsTotal > check.diagnostics.length) lines.push(`  …${check.diagnosticsTotal - check.diagnostics.length} more errors`);
    if (check.excerpt) lines.push(`  last lines:\n${check.excerpt.split('\n').map((l) => `    ${l}`).join('\n')}`);
    if (check.status !== 'passed' && check.logPath) lines.push(`  full log: ${check.logPath}`);
  }
  for (const entry of declared) {
    lines.push(`${entry.dependency}: declared ${entry.declared ?? 'nowhere'} in ${entry.manifestPath} (upgrade target ${entry.target ?? '—'})`);
  }

  let text = lines.join('\n');
  const limit = maxBytes(budget);
  if (byteLength(text) > limit) {
    const note = '\n(cut at the size limit; full logs are at the paths above)';
    text = clipLines(text, limit - byteLength(note)).text + note;
  }
  return { text, bytes: byteLength(text), estimatedTokens: estimateTokens(text), passed, checks, declared };
}

/**
 * What each upgraded npm dependency is declared as now.
 *
 * A fix that "passes" by moving the dependency back is not a fix, and an agent
 * deep in a failing build is exactly when that edit gets made. Only npm
 * manifests are read; other ecosystems report nothing rather than guessing.
 */
async function declaredVersions(
  root: string,
  changes: readonly DependencyChange[],
): Promise<WorkingTreeCheckReport['declared']> {
  const out: WorkingTreeCheckReport['declared'] = [];
  for (const change of changes) {
    if (change.ecosystem !== 'npm' || !change.manifestPath.endsWith('package.json')) continue;
    let declared: string | null = null;
    try {
      const manifest = JSON.parse(await readFile(join(root, change.manifestPath), 'utf8')) as Record<string, Record<string, string> | undefined>;
      for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        const spec = manifest[section]?.[change.name];
        if (spec) {
          declared = spec;
          break;
        }
      }
    } catch {
      declared = null;
    }
    out.push({ dependency: change.name, manifestPath: change.manifestPath, target: change.to, declared });
  }
  return out;
}
