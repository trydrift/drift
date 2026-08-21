import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const SKIPPED = new Set(['node_modules', '.git', '.drift']);

/** Absolute paths of every file under `root`, sorted, skipping dependency and VCS noise. */
export async function walkPaths(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIPPED.has(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await walkPaths(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
