import semver from 'semver';
import { isRuntimeConfigPath } from '../index/walk.js';

/**
 * Where this repository itself declares the Node.js version it runs on.
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
): RuntimeDeclaration[] {
  const out: RuntimeDeclaration[] = [];

  for (const { path, content } of files) {
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
