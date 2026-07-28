import { parse as parseYaml } from 'yaml';
import { DriftConfigSchema, DEFAULT_CONFIG, type DriftConfig } from './schema.js';

/** Locations checked, in order. First one that exists wins. */
export const CONFIG_PATHS = [
  '.github/drift.yml',
  '.github/drift.yaml',
  'drift.yml',
  'drift.yaml',
] as const;

export interface ConfigLoadResult {
  config: DriftConfig;
  /** Path the config came from, or `null` when defaults were used. */
  path: string | null;
  /** Human-readable problems. Non-fatal — Drift falls back to defaults. */
  problems: string[];
}

/**
 * Parse a `drift.yml` document.
 *
 * A malformed config must never take the pipeline down: we degrade to
 * defaults (which are the safe, approval-required settings) and report the
 * problem in the run output so the user notices without being blocked.
 */
export function parseConfig(raw: string, path: string | null = null): ConfigLoadResult {
  const problems: string[] = [];

  if (!raw.trim()) {
    return { config: DEFAULT_CONFIG, path, problems };
  }

  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    problems.push(`Could not parse ${path ?? 'config'} as YAML: ${(err as Error).message}`);
    return { config: DEFAULT_CONFIG, path, problems };
  }

  if (doc === null || doc === undefined) {
    return { config: DEFAULT_CONFIG, path, problems };
  }

  const parsed = DriftConfigSchema.safeParse(doc);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const where = issue.path.length ? issue.path.join('.') : '(root)';
      problems.push(`${where}: ${issue.message}`);
    }
    problems.push('Falling back to Drift defaults (mode: approve).');
    return { config: DEFAULT_CONFIG, path, problems };
  }

  return { config: parsed.data, path, problems };
}

/**
 * Load config through a caller-supplied reader.
 *
 * The reader indirection keeps this module free of both `fs` and Octokit, so
 * the same code path serves the Action (local checkout) and the webhook
 * server (Contents API) without duplication.
 */
export async function loadConfig(
  read: (path: string) => Promise<string | null>,
): Promise<ConfigLoadResult> {
  for (const path of CONFIG_PATHS) {
    let raw: string | null;
    try {
      raw = await read(path);
    } catch {
      continue;
    }
    if (raw !== null) return parseConfig(raw, path);
  }
  return { config: DEFAULT_CONFIG, path: null, problems: [] };
}
