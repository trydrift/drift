import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import { publicCaseSchema, validateCase, type PublicCase } from './schema.ts';

/**
 * Layer C's only entry point into case storage.
 *
 * This module deliberately knows nothing about `eval/cases/private` — not the
 * path, not the schema, not the loader. An adapter that imports from here
 * cannot reach ground truth even by accident, because the code that reads it
 * is not in this module's import graph at all. The private loader lives in
 * `./private.ts` and is imported only by the evaluator.
 */

export function publicCasesRoot(root = process.cwd()): string {
  return join(root, 'eval', 'cases', 'public');
}

export async function listCaseIds(root?: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(publicCasesRoot(root), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export async function loadPublicCase(caseId: string, root?: string): Promise<PublicCase> {
  const dir = join(publicCasesRoot(root), caseId);
  const body = await readFile(join(dir, 'case.yml'), 'utf8');
  const parsed = publicCaseSchema.parse(YAML.parse(body));

  if (parsed.id !== caseId) {
    throw new Error(`Case directory ${caseId} declares id ${parsed.id}.`);
  }
  const problems = validateCase(parsed);
  if (problems.length > 0) {
    throw new Error(`Case ${caseId} is internally inconsistent:\n  ${problems.join('\n  ')}`);
  }
  return parsed;
}

export async function loadPublicCases(root?: string): Promise<PublicCase[]> {
  const ids = await listCaseIds(root);
  return Promise.all(ids.map((id) => loadPublicCase(id, root)));
}

/** Where a case's frozen public artifacts live. Never contains private material — see `auditWorkspaceIsolation`. */
export function publicCaseDir(caseId: string, root?: string): string {
  return join(publicCasesRoot(root), caseId);
}
