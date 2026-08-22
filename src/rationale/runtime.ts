import semver from 'semver';
import { isRuntimeConfigPath } from '../index/walk.js';
import { memberOf } from '../detect/workspace.js';
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
  allMembers?: readonly string[],
): RuntimeDeclaration[] {
  const out: RuntimeDeclaration[] = [];

  for (const { path, content } of scopedTo(files, member, allMembers)) {
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
 * should actually be read from: that workspace's own directory, plus
 * anything that is not any workspace's business in particular — a root
 * config file in a repository where the root itself is not a package, or a
 * CI workflow, which conventionally governs the whole build regardless of
 * which member happens to own its directory.
 *
 * Without this, a runtime finder handed the whole repository's file list can
 * resolve a monorepo's Python service's `.python-version` against a sibling
 * Node package's dependency upgrade, because both files simply appear in the
 * same flat list.
 *
 * `member === undefined` means no workspace context is known at all (a
 * single-package repository, or a caller that has not gathered one) — every
 * file is kept, matching the tool's original behavior before workspace
 * scoping existed. `member === ''` is a real, meaningful case: the *root*
 * workspace of a multi-package repository, which must not inherit a sibling
 * member's declarations just because `''` is falsy.
 *
 * Ownership is resolved with `memberOf`, the same helper that already
 * attributes a dependency's own manifest to a workspace elsewhere in Drift,
 * rather than a second, independent guess at path prefixes.
 */
/**
 * Root-owned files that declare *a package's own* runtime, not the whole
 * repository's. When the root directory is itself a workspace member,
 * `memberOf` attributes these to `''` the same way it would attribute
 * `packages/api/package.json` to `'packages/api'` — that is correct for
 * finding the root package's own declaration, but wrong to then treat as
 * repository-global the way a root `.nvmrc` or CI workflow is.
 */
const MANIFEST_BASENAMES = new Set(['package.json', 'pyproject.toml', 'setup.cfg', 'setup.py']);

function scopedTo<T extends { path: string }>(
  files: readonly T[],
  member: string | undefined,
  allMembers: readonly string[] | undefined,
): readonly T[] {
  if (member === undefined) return files;
  const members = allMembers ?? [];
  return files.filter((f) => {
    const owner = memberOf(f.path, members);
    if (owner === member) return true;
    // No member directory claims this file at all — genuinely repository-
    // global by construction (or the root is not itself a registered member).
    if (owner === null) return true;
    if (owner === '') {
      // The root workspace's own files. A CI workflow, `.nvmrc`, or Dockerfile
      // at the root conventionally governs the whole build regardless of
      // which member happens to own the root directory — but a root package
      // manifest is that package's own declared runtime, and must not leak
      // into a sibling member's compatibility check just because the root
      // happens to also be a workspace member.
      const base = (f.path.split('/').pop() ?? '').toLowerCase();
      return !MANIFEST_BASENAMES.has(base);
    }
    return false;
  });
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
  allMembers?: readonly string[],
): RuntimeDeclaration[] {
  const out: RuntimeDeclaration[] = [];

  for (const { path, content } of scopedTo(files, member, allMembers)) {
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
      const call = extractSetupCall(content);
      const match = call ? /\bpython_requires\s*=\s*(['"])([^'"]+)\1/.exec(call) : null;
      if (match?.[2]) out.push({ file: path, line: lineOf(content, /python_requires\s*=/), requirement: match[2] });
      continue;
    }

    if (base === '.python-version') {
      // Pyenv allows more than one version in this file — one per line, or
      // several whitespace-separated on one line — and treats a `#` line as a
      // comment. Reading only the first line can miss an older version this
      // repository also builds and runs on, which is exactly the version a
      // compatibility verdict needs to fail against.
      for (const [i, line] of content.split('\n').entries()) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        for (const token of trimmed.split(/\s+/)) {
          out.push({ file: path, line: i + 1, requirement: token });
        }
      }
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

/**
 * Isolate the `setup(...)` invocation's argument list, so a `python_requires`
 * mentioned in a comment, an unrelated assignment, or someone else's `setup`
 * method is never read as the package's declaration.
 *
 * Comment lines are blanked out first (a `#`-prefixed line only — a `#`
 * appearing after code on the same line is left alone, since a bare regex
 * cannot tell that apart from a `#` inside a string literal). Only a bare
 * `setup(` or a `setuptools.setup(` call counts as the invocation —
 * `helper.setup(...)`, a call on some unrelated object that merely shares the
 * method name, is excluded by requiring the call not be preceded by a `.` or
 * another identifier character (see `CALL_PATTERN`). The last matching call in
 * the file is taken, since that is conventionally the actual invocation;
 * anything named `def setup(...)` is excluded so a helper function of the
 * same name is not mistaken for it.
 *
 * The argument list itself is then isolated with a string-aware scan for the
 * matching close paren, rather than a bare character count — a `)` inside a
 * string argument (`long_description="See docs (v2)."`) must not be read as
 * ending the call early, which would silently drop every keyword argument
 * after it, `python_requires` very much included.
 */
const CALL_PATTERN = /(?<!def\s+)(?:(?<![.\w])setup|(?<!\w)setuptools\.setup)\s*\(/g;

function extractSetupCall(content: string): string | null {
  const withoutCommentLines = content
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? '' : line))
    .join('\n');

  const calls = [...withoutCommentLines.matchAll(CALL_PATTERN)];
  const last = calls.at(-1);
  if (!last) return null;

  const openIndex = last.index + last[0].length - 1;
  const closeIndex = matchingParenIndex(withoutCommentLines, openIndex);
  return closeIndex === null ? null : withoutCommentLines.slice(openIndex, closeIndex + 1);
}

/**
 * The index of the `)` that closes the `(` at `openIndex`, skipping over the
 * contents of any string literal along the way — single- or double-quoted,
 * plain or triple-quoted, with escapes honoured in the non-triple forms.
 *
 * Returns `null` on anything this cannot confidently resolve (an unterminated
 * string, no matching close paren before the file ends), which is the safe
 * failure here: `extractSetupCall` then reports no call at all, and the
 * caller reports no declaration rather than one sliced at the wrong place.
 */
function matchingParenIndex(text: string, openIndex: number): number | null {
  let depth = 0;
  let i = openIndex;
  while (i < text.length) {
    const ch = text[i]!;

    if (ch === "'" || ch === '"') {
      const triple = text.slice(i, i + 3) === ch.repeat(3);
      const closer = triple ? ch.repeat(3) : ch;
      let j = i + closer.length;
      let terminated = false;
      while (j < text.length) {
        if (!triple && text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text.startsWith(closer, j)) {
          j += closer.length;
          terminated = true;
          break;
        }
        j += 1;
      }
      if (!terminated) return null;
      i = j;
      continue;
    }

    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
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
