import semver from 'semver';
import { isRuntimeConfigPath } from '../index/walk.js';
import { intersectsInterval, isSubsetInterval, parseSpecifierSet } from './pep440.js';

/**
 * Where this repository itself declares a runtime version.
 */
export interface RuntimeDeclaration {
  /** Repo-relative path. */
  file: string;
  /** 1-indexed. */
  line: number;
  /** The version or range exactly as declared, e.g. ">=22.6.0", "22", "22.6.0". */
  requirement: string;
}

export interface RuntimeCompatibility extends RuntimeDeclaration {
  verdict: 'compatible' | 'incompatible' | 'partial';
}

/**
 * Find every place this repository declares its own Node.js version.
 *
 * Reuses whatever file contents the caller already read into memory -- no
 * extra I/O -- and only trusts the config surfaces `isRuntimeConfigPath`
 * already knows to check: `package.json#engines`, `.nvmrc`/`.node-version`,
 * Dockerfiles, and GitHub Actions workflow `node-version:` lines. A value
 * this cannot resolve to a literal version -- a matrix expression like
 * `${{ matrix.node }}` -- is left out rather than guessed at.
 */
export function findNodeDeclarations(
  files: readonly { path: string; content: string }[],
  member?: string,
): RuntimeDeclaration[] {
  const out: RuntimeDeclaration[] = [];

  for (const { path, content } of scopedTo(files, member)) {
    if (!isRuntimeConfigPath(path)) continue;
    const base = (path.split('/').pop() ?? '').toLowerCase();

    if (base === 'package.json') {
      const requirement = engineFromPackageJson(content);
      if (requirement) out.push({ file: path, line: lineOf(content, /"node"\s*:/), requirement });
      continue;
    }

    if (base === '.nvmrc' || base === '.node-version') {
      const requirement = content.trim().split('\n')[0]?.replace(/^v/i, '').trim();
      if (requirement) out.push({ file: path, line: 1, requirement });
      continue;
    }

    if (base.startsWith('dockerfile')) {
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const match = /^\s*FROM\s+node:([^\s@]+)/i.exec(lines[i]!);
        const tag = match?.[1]?.split('-')[0];
        if (tag) out.push({ file: path, line: i + 1, requirement: tag });
      }
      continue;
    }

    if (/^\.github\/workflows\/.+\.ya?ml$/.test(path)) {
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const match = /node-version\s*:\s*['"]?([^\s'"#]+)['"]?/i.exec(lines[i]!);
        const requirement = match?.[1];
        if (!requirement || /[${}]/.test(requirement)) continue;
        out.push({ file: path, line: i + 1, requirement });
      }
    }
  }

  return out;
}

/**
 * Narrow a repository's files to the ones a runtime declaration for `member`
 * should actually be read from: the workspace's own directory, plus
 * repo-root files that plausibly apply to every workspace.
 *
 * Without this, a runtime finder handed the whole repository's file list —
 * as every call site here used to pass it — can resolve a monorepo's Python
 * service's `.python-version` against a sibling Node package's dependency
 * upgrade, because both files simply appear in the same flat list. `member`
 * is the workspace directory the dependency being analyzed actually belongs
 * to; when it is known, a declaration nested inside a *different*
 * workspace's directory is not this workspace's floor and is left out.
 */
function scopedTo<T extends { path: string }>(files: readonly T[], member: string | undefined): readonly T[] {
  if (!member) return files;
  const prefix = `${member.replace(/\/$/, '')}/`;
  return files.filter((f) => f.path.startsWith(prefix) || !f.path.includes('/'));
}

function engineFromPackageJson(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as { engines?: { node?: string } };
    return parsed.engines?.node ?? null;
  } catch {
    return null;
  }
}

function lineOf(content: string, pattern: RegExp): number {
  const idx = content.split('\n').findIndex((line) => pattern.test(line));
  return idx >= 0 ? idx + 1 : 1;
}

/**
 * Does everything this repository declares as its Node.js floor also satisfy
 * a dependency's newly raised requirement?
 *
 * Declarations are compared as ranges, not single versions -- ">=22.6.0" and
 * a bare CI major like "22" both denote a set of versions, not one -- so
 * `semver.subset` answers the question that actually matters: does every
 * version this repository could run on also satisfy the new floor. That is
 * stronger than `semver.intersects`, which would call ">=20.0.0" compatible
 * with "^22.13.0" just because the two overlap starting at 22.13.
 */
export function checkNodeCompatibility(
  declarations: readonly RuntimeDeclaration[],
  requirement: string,
): RuntimeCompatibility[] {
  const out: RuntimeCompatibility[] = [];

  for (const decl of declarations) {
    if (!semver.validRange(decl.requirement, { loose: true })) continue;

    let verdict: RuntimeCompatibility['verdict'];
    try {
      if (semver.subset(decl.requirement, requirement, { loose: true })) verdict = 'compatible';
      else if (!semver.intersects(decl.requirement, requirement, { loose: true })) verdict = 'incompatible';
      else verdict = 'partial';
    } catch {
      continue;
    }

    out.push({ ...decl, verdict });
  }

  return out;
}

/**
 * Find every place this repository declares its own Python version.
 *
 * `pyproject.toml`'s `[project] requires-python` is read with a table-scoped
 * line reader rather than a whole-file regex, so a `requires-python`-looking
 * string inside `[tool.poetry.dependencies]` or a comment is never mistaken
 * for the declaration. `setup.py` is different in kind: it is executable
 * Python, not data, so only a literal `python_requires="..."` keyword
 * argument is trusted — anything computed is left out rather than evaluated.
 */
export function findPythonDeclarations(
  files: readonly { path: string; content: string }[],
  member?: string,
): RuntimeDeclaration[] {
  const out: RuntimeDeclaration[] = [];

  for (const { path, content } of scopedTo(files, member)) {
    if (!isRuntimeConfigPath(path)) continue;
    const base = (path.split('/').pop() ?? '').toLowerCase();

    if (base === 'pyproject.toml') {
      const found = requiresPythonFromPyproject(content);
      if (found) out.push({ file: path, line: found.line, requirement: found.requirement });
      continue;
    }

    if (base === 'setup.cfg') {
      const found = pythonRequiresFromSetupCfg(content);
      if (found) out.push({ file: path, line: found.line, requirement: found.requirement });
      continue;
    }

    if (base === 'setup.py') {
      const line = lineOf(content, /python_requires\s*=/);
      const match = /python_requires\s*=\s*(['"])([^'"]+)\1/.exec(content);
      if (match?.[2]) out.push({ file: path, line, requirement: match[2] });
      continue;
    }

    if (base === '.python-version') {
      const requirement = content.trim().split('\n')[0]?.trim();
      if (requirement) out.push({ file: path, line: 1, requirement });
      continue;
    }

    if (base === 'runtime.txt') {
      const requirement = content.trim().split('\n')[0]?.replace(/^python-/i, '').trim();
      if (requirement) out.push({ file: path, line: 1, requirement });
    }
  }

  return out;
}

/**
 * Read `requires-python` out of `pyproject.toml`'s `[project]` table only.
 *
 * Tracks the current table header line by line rather than searching the
 * whole file, so the same key spelled inside `[tool.*]` — a common place for
 * a build backend to also read a Python constraint — is not read as the
 * package's own declaration.
 */
function requiresPythonFromPyproject(content: string): { requirement: string; line: number } | null {
  const lines = content.split('\n');
  let inProjectTable = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      inProjectTable = header[1]!.trim() === 'project';
      continue;
    }
    if (!inProjectTable) continue;

    const match = /^\s*requires-python\s*=\s*(.+?)\s*$/.exec(line);
    if (!match) continue;

    const requirement = parseTomlString(match[1]!);
    if (requirement) return { requirement, line: i + 1 };
  }

  return null;
}

/** A TOML basic or literal string, with a trailing `# comment` stripped when unquoted. */
function parseTomlString(raw: string): string | null {
  const quoted = /^(['"])(.*)\1/.exec(raw);
  if (quoted) return quoted[2]!;
  return raw.split('#')[0]?.trim() || null;
}

/** Read `python_requires` out of `setup.cfg`'s `[options]` section only. */
function pythonRequiresFromSetupCfg(content: string): { requirement: string; line: number } | null {
  const lines = content.split('\n');
  let inOptionsSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      inOptionsSection = header[1]!.trim() === 'options';
      continue;
    }
    if (!inOptionsSection) continue;

    const match = /^\s*python_requires\s*=\s*(.+?)\s*$/.exec(line);
    if (!match) continue;

    const requirement = match[1]!.split(';')[0]?.trim();
    if (requirement) return { requirement, line: i + 1 };
  }

  return null;
}

/**
 * Does everything this repository declares as its Python floor also satisfy
 * a dependency's newly raised `requires-python`?
 *
 * Same question `checkNodeCompatibility` answers for Node, over PEP 440
 * intervals instead of semver ranges — see `pep440.ts` for what "interval"
 * means here and where it cannot be exact.
 */
export function checkPythonCompatibility(
  declarations: readonly RuntimeDeclaration[],
  requirement: string,
): RuntimeCompatibility[] {
  const required = parseSpecifierSet(requirement);
  const out: RuntimeCompatibility[] = [];

  for (const decl of declarations) {
    const declared = parseSpecifierSet(decl.requirement);

    let verdict: RuntimeCompatibility['verdict'];
    if (isSubsetInterval(declared, required)) verdict = 'compatible';
    else if (!intersectsInterval(declared, required)) verdict = 'incompatible';
    else verdict = 'partial';

    out.push({ ...decl, verdict });
  }

  return out;
}
