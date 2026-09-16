import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import YAML from 'yaml';
import {
  caseSchema,
  hiddenSchema,
  suiteSchema,
  type AgentCase,
  type HiddenMaterial,
  type SuiteManifest,
} from './schema.ts';

/**
 * Case storage for the agent benchmark.
 *
 * Layout:
 *
 *   eval/agent/cases/<id>/case.yml          public
 *   eval/agent/cases/<id>/fixture/          public, synthetic cases only
 *   eval/agent/cases/<id>/hidden/hidden.yml private
 *   eval/agent/cases/<id>/hidden/*          private: reference.patch, test files
 *   eval/agent/suites/<suite>.json          which cases a result is over
 *
 * The public and private halves share a directory for authoring convenience;
 * what keeps them apart is that the runner materializes a workspace from the
 * *source* (a git mirror or `fixture/start`), never from the case directory,
 * and audits the result for anything named like private material. See
 * `workspace.ts`.
 */

export function agentRoot(root = process.cwd()): string {
  return join(root, 'eval', 'agent');
}

export function casesRoot(root?: string): string {
  return join(agentRoot(root), 'cases');
}

export function caseDir(caseId: string, root?: string): string {
  return join(casesRoot(root), caseId);
}

export function hiddenDir(caseId: string, root?: string): string {
  return join(caseDir(caseId, root), 'hidden');
}

export function suitesRoot(root?: string): string {
  return join(agentRoot(root), 'suites');
}

export async function listCaseIds(root?: string): Promise<string[]> {
  try {
    const entries = await readdir(casesRoot(root), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

export async function loadCase(caseId: string, root?: string): Promise<AgentCase> {
  const body = await readFile(join(caseDir(caseId, root), 'case.yml'), 'utf8');
  const parsed = caseSchema.parse(YAML.parse(body));
  if (parsed.id !== caseId) throw new Error(`Case directory ${caseId} declares id ${parsed.id}.`);
  const problems = validateCaseShape(parsed);
  if (problems.length > 0) throw new Error(`Case ${caseId} is invalid:\n  - ${problems.join('\n  - ')}`);
  return parsed;
}

export async function loadCases(caseIds: readonly string[], root?: string): Promise<AgentCase[]> {
  const cases: AgentCase[] = [];
  for (const id of caseIds) cases.push(await loadCase(id, root));
  return cases;
}

/** Invariants the schema alone cannot state. */
export function validateCaseShape(agentCase: AgentCase): string[] {
  const problems: string[] = [];
  for (const [label, version] of [
    ['fromVersion', agentCase.dependency.fromVersion],
    ['toVersion', agentCase.dependency.toVersion],
  ] as const) {
    if (/[\^~*x><|\s]/.test(version)) problems.push(`dependency.${label} must be an exact version, got "${version}".`);
  }
  if (agentCase.dependency.fromVersion === agentCase.dependency.toVersion) {
    problems.push('dependency.fromVersion and dependency.toVersion are equal; nothing was upgraded.');
  }
  if (agentCase.source.kind === 'git') {
    if (!agentCase.source.startCommit && !agentCase.source.startPatch) {
      problems.push('a git source needs either source.startCommit or source.startPatch.');
    }
    if (agentCase.source.startCommit && agentCase.source.startPatch) {
      problems.push('source.startCommit and source.startPatch are exclusive.');
    }
    if (agentCase.source.baseCommit === agentCase.source.startCommit) {
      problems.push('source.baseCommit and source.startCommit are equal; the start state must contain the bump.');
    }
    if (agentCase.provenance === 'historical' && !agentCase.source.fixCommit && !agentCase.source.reference) {
      problems.push('a historical case should name its fixCommit or a reference URL.');
    }
  }
  if (agentCase.source.kind === 'fixture' && agentCase.provenance === 'historical') {
    problems.push('a fixture-sourced case cannot be historical.');
  }
  if (agentCase.provenance === 'synthetic' && agentCase.role === 'held-out') {
    problems.push('a synthetic case cannot be held-out.');
  }
  return problems;
}

/**
 * The private half. Called only by the validation and admission layers —
 * never by anything that builds a prompt. `eval/src/agent/isolation.test.ts`
 * asserts the prompt and provider modules do not import this file.
 */
export async function loadHidden(caseId: string, root?: string): Promise<HiddenMaterial> {
  const dir = hiddenDir(caseId, root);
  const body = await readFile(join(dir, 'hidden.yml'), 'utf8');
  const parsed = hiddenSchema.parse(YAML.parse(body));
  if (parsed.caseId !== caseId) throw new Error(`Hidden material in ${caseId} declares caseId ${parsed.caseId}.`);

  const referencePatch = await readFile(join(dir, parsed.referencePatch), 'utf8');
  const tests = [];
  for (const test of parsed.tests) {
    const files: Record<string, string> = {};
    for (const name of test.files) {
      // A declared file that is missing is a broken case, never a test that
      // quietly asserts nothing.
      files[`.drift-hidden/${name}`] = await readFile(join(dir, name), 'utf8');
    }
    tests.push({ ...test, files });
  }

  return { ...parsed, referencePatch, tests };
}

/**
 * Content hash of everything that defines a case: the public description and
 * the whole private half. Any change to either produces a new hash, and a
 * frozen suite refuses to run or aggregate a case whose hash moved.
 */
export async function hashCase(caseId: string, root?: string): Promise<string> {
  const hash = createHash('sha256');
  const dir = caseDir(caseId, root);
  const files = (await walk(dir)).sort();
  for (const path of files) {
    hash.update(relative(dir, path).split(sep).join('/'));
    hash.update('\0');
    hash.update(await readFile(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      out.push(...(await walk(path)));
    } else if (entry.isFile()) {
      out.push(path);
    }
  }
  return out;
}

export async function loadSuite(suite: string, root?: string): Promise<SuiteManifest> {
  const body = await readFile(join(suitesRoot(root), `${suite}.json`), 'utf8');
  const parsed = suiteSchema.parse(JSON.parse(body));
  if (parsed.suite !== suite) throw new Error(`Suite file ${suite}.json declares suite ${parsed.suite}.`);
  return parsed;
}

export async function listSuites(root?: string): Promise<string[]> {
  try {
    const entries = await readdir(suitesRoot(root));
    return entries.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length)).sort();
  } catch {
    return [];
  }
}

/**
 * Every hash mismatch between a suite manifest and the cases on disk. A
 * frozen suite with any mismatch cannot be run or aggregated; a draft suite
 * only reports them.
 */
export async function suiteHashMismatches(manifest: SuiteManifest, root?: string): Promise<string[]> {
  const mismatches: string[] = [];
  for (const entry of manifest.cases) {
    let actual: string;
    try {
      actual = await hashCase(entry.id, root);
    } catch (err) {
      mismatches.push(`${entry.id}: could not be hashed (${(err as Error).message})`);
      continue;
    }
    if (actual !== entry.caseHash) mismatches.push(`${entry.id}: manifest has ${entry.caseHash.slice(0, 12)}, disk has ${actual.slice(0, 12)}`);
  }
  return mismatches;
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
