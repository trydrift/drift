import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/**
 * Stable hashing for fixture revisions.
 *
 * A review or an adjudication only applies to the exact fixture evidence it
 * inspected. These hashes are what "exact" means: deterministic across
 * machines and re-runs (sorted paths, no timestamps, no absolute paths), so a
 * stored hash can be compared against a freshly computed one to detect drift.
 */

const EXCLUDED_DIR_NAMES = new Set(['node_modules', '.git']);

export interface FixtureHashes {
  fixtureMetadata: string;
  upstreamOld: string;
  upstreamNew: string;
  consumer: string;
  oracles: string;
  goldPatch: string;
  /**
   * The fixture's benchmark-added hidden behavioural checks.
   *
   * Hashed alongside the rest because a hidden check is ground truth: it
   * states what behaviour a correct migration must preserve, and it can
   * disqualify a repair on its own. Editing one after a review accepted it
   * would let this project change the definition of a correct repair without
   * anybody reviewing the change, which is exactly what staleness exists to
   * prevent. `sha256('')` when a fixture has none.
   */
  hiddenChecks: string;
}

export async function hashFixtureRevision(fixtureDir: string, fixtureYamlBody: string): Promise<FixtureHashes> {
  const [upstreamOld, upstreamNew, consumer, goldPatch, hiddenChecks] = await Promise.all([
    hashTree(join(fixtureDir, 'upstream', 'old')),
    hashTree(join(fixtureDir, 'upstream', 'new')),
    hashTree(join(fixtureDir, 'consumer')),
    hashOptionalFile(join(fixtureDir, 'expected', 'gold.patch')),
    hashTree(join(fixtureDir, 'hidden')),
  ]);

  return {
    fixtureMetadata: hashFixtureMetadata(fixtureYamlBody),
    upstreamOld,
    upstreamNew,
    consumer,
    oracles: hashOracleSection(fixtureYamlBody),
    goldPatch,
    hiddenChecks,
  };
}

/**
 * Hashes the fixture.yml body, excluding the `readiness` field: readiness is
 * a workflow marker set by `eval:review:validate`'s output, not evidence a
 * review inspects, and letting it participate would make accepting a review
 * retroactively stale the very fixture.yml write that recorded it.
 */
export function hashFixtureMetadata(fixtureYamlBody: string): string {
  const withoutReadiness = fixtureYamlBody
    .split('\n')
    .filter((line) => !/^readiness:/.test(line))
    .join('\n');
  return sha256(canonicalizeText(withoutReadiness));
}

function hashOracleSection(fixtureYamlBody: string): string {
  const match = fixtureYamlBody.match(/^oracles:\n(?:^ {2}.*\n?)*/m);
  return sha256(canonicalizeText(match ? match[0] : ''));
}

async function hashOptionalFile(path: string): Promise<string> {
  try {
    const content = await readFile(path, 'utf8');
    return sha256(canonicalizeText(content));
  } catch {
    return sha256('');
  }
}

/** Hash a directory's relative paths and contents, sorted, excluding VCS/dependency noise. */
export async function hashTree(root: string): Promise<string> {
  const hash = createHash('sha256');
  const files = await listFilesSorted(root);
  for (const file of files) {
    const relPath = relative(root, file).split(sep).join('/');
    hash.update(relPath);
    hash.update('\0');
    hash.update(await readFile(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function listFilesSorted(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesSorted(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function canonicalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
