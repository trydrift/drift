import ts from 'typescript';
import { fetchJson, fetchText } from '../util/http.js';

/**
 * TypeScript declaration-surface diffing.
 *
 * Changelogs lie by omission — the single most common cause of a "minor"
 * upgrade breaking a build is a removal nobody wrote down. This module reads
 * the actual `.d.ts` of both versions and diffs the exported API, which makes
 * it the highest-weight evidence Drift can produce for npm packages.
 *
 * Declarations are fetched from jsDelivr rather than installed, because Drift
 * must be able to compare the *old* version, which by definition is no longer
 * in `node_modules` after the upgrade. Fetching also keeps Drift from ever
 * executing third-party install scripts.
 */

export type SurfaceKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'variable'
  | 'enum'
  | 'namespace';

export interface SurfaceEntry {
  name: string;
  kind: SurfaceKind;
  /** Normalised declaration text, whitespace-collapsed, for comparison. */
  signature: string;
  /** Member names for classes/interfaces/enums, so we can diff them too. */
  members: string[];
  /** Required member names, so optional -> required is detectable. */
  requiredMembers: string[];
}

export type SurfaceApi = Map<string, SurfaceEntry>;

export type SurfaceChangeKind =
  | 'export-removed'
  | 'signature-changed'
  | 'kind-changed'
  | 'member-removed'
  | 'member-now-required';

export interface SurfaceChange {
  kind: SurfaceChangeKind;
  symbol: string;
  detail: string;
  before?: string;
  after?: string;
}

const JSDELIVR_DATA = 'https://data.jsdelivr.com/v1/packages/npm';
const JSDELIVR_CDN = 'https://cdn.jsdelivr.net/npm';

/** Fetch and parse the public type surface of one published npm version. */
export async function fetchTypeSurface(
  packageName: string,
  version: string,
): Promise<{ api: SurfaceApi; entryPath: string } | null> {
  const entryPath = await resolveTypesEntry(packageName, version);
  if (!entryPath) return null;

  const sources = await collectDeclarationSources(packageName, version, entryPath);
  if (sources.length === 0) return null;

  const api: SurfaceApi = new Map();
  for (const source of sources) extractExports(source.content, source.path, api);

  return api.size > 0 ? { api, entryPath } : null;
}

/**
 * Locate the package's type declarations.
 *
 * Checks `types`/`typings`, then the `exports` map (modern packages put types
 * only there), then conventional fallbacks, then DefinitelyTyped. A package
 * with no declarations simply yields no evidence from this source.
 */
async function resolveTypesEntry(packageName: string, version: string): Promise<string | null> {
  const pkg = await fetchJson<{
    types?: string;
    typings?: string;
    exports?: unknown;
    main?: string;
  }>(`${JSDELIVR_CDN}/${packageName}@${version}/package.json`);

  if (pkg) {
    const declared = pkg.types ?? pkg.typings ?? typesFromExports(pkg.exports);
    if (declared) return normalizePath(declared);

    // A JS entry point often has a sibling declaration file.
    if (pkg.main) {
      const sibling = normalizePath(pkg.main).replace(/\.(c|m)?js$/, '.d.ts');
      if (await exists(packageName, version, sibling)) return sibling;
    }
  }

  for (const candidate of ['index.d.ts', 'dist/index.d.ts', 'lib/index.d.ts', 'types/index.d.ts']) {
    if (await exists(packageName, version, candidate)) return candidate;
  }

  // DefinitelyTyped ships types for the same *major* line, so this is only a
  // sound comparison when both sides resolve; mismatches yield no evidence.
  const dtName = packageName.startsWith('@')
    ? `@types/${packageName.slice(1).replace('/', '__')}`
    : `@types/${packageName}`;
  if (await exists(dtName, 'latest', 'index.d.ts')) return `@types:${dtName}`;

  return null;
}

function typesFromExports(exportsField: unknown): string | null {
  if (!exportsField || typeof exportsField !== 'object') return null;

  // Walk the conditional-exports tree looking for any `types` condition,
  // preferring the root entry (".") when one exists.
  const visit = (node: unknown, depth: number): string | null => {
    if (depth > 6 || !node || typeof node !== 'object') return null;
    const record = node as Record<string, unknown>;

    const types = record.types ?? record.typings;
    if (typeof types === 'string') return types;

    const preferred = ['.', 'import', 'require', 'default', 'node'];
    for (const key of [...preferred, ...Object.keys(record)]) {
      if (!(key in record)) continue;
      const found = visit(record[key], depth + 1);
      if (found) return found;
    }
    return null;
  };

  return visit(exportsField, 0);
}

interface DeclarationSource {
  path: string;
  content: string;
}

/**
 * Fetch the entry declaration and follow its re-exports.
 *
 * Barrel files (`export * from './client'`) are near-universal, so reading only
 * the entry point would see almost nothing. The traversal is depth- and
 * count-bounded because we are walking an untrusted package's file graph.
 */
async function collectDeclarationSources(
  packageName: string,
  version: string,
  entryPath: string,
): Promise<DeclarationSource[]> {
  if (entryPath.startsWith('@types:')) {
    const dtName = entryPath.slice('@types:'.length);
    const content = await fetchText(`${JSDELIVR_CDN}/${dtName}@latest/index.d.ts`);
    return content ? [{ path: 'index.d.ts', content }] : [];
  }

  const MAX_FILES = 25;
  const sources: DeclarationSource[] = [];
  const seen = new Set<string>();
  const queue: string[] = [entryPath];

  while (queue.length > 0 && sources.length < MAX_FILES) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);

    const content = await fetchText(`${JSDELIVR_CDN}/${packageName}@${version}/${path}`, {
      retries: 0,
    });
    if (!content) continue;

    sources.push({ path, content });

    for (const specifier of relativeReExports(content)) {
      for (const resolved of resolveRelative(path, specifier)) {
        if (!seen.has(resolved)) queue.push(resolved);
      }
    }
  }

  return sources;
}

/** `export * from './x'` / `export { a } from './x'` — relative targets only. */
function relativeReExports(content: string): string[] {
  const out = new Set<string>();
  for (const match of content.matchAll(/\bexport\s+(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+['"](\.[^'"]+)['"]/g)) {
    out.add(match[1]!);
  }
  return [...out];
}

/** Candidate paths a relative specifier could resolve to, most likely first. */
function resolveRelative(fromPath: string, specifier: string): string[] {
  const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
  const joined = normalizePath(dir ? `${dir}/${specifier}` : specifier);
  const base = joined.replace(/\.(d\.ts|js|ts)$/, '');
  return [`${base}.d.ts`, `${base}/index.d.ts`];
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const segment of path.replace(/^\.\//, '').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

async function exists(packageName: string, version: string, path: string): Promise<boolean> {
  const content = await fetchText(`${JSDELIVR_CDN}/${packageName}@${version}/${path}`, { retries: 0 });
  return content !== null;
}

/**
 * Extract exported declarations using the TypeScript compiler's own parser.
 *
 * Using the real parser rather than regexes matters here: overloads, generics,
 * and multi-line signatures are exactly the constructs that break naive
 * matching, and they are also the ones most likely to have changed.
 */
export function extractExports(content: string, fileName: string, into: SurfaceApi = new Map()): SurfaceApi {
  const source = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const visit = (node: ts.Node): void => {
    if (!isExported(node)) {
      // Descend into ambient module/namespace bodies, whose contents are
      // exported even when the inner declarations lack a modifier.
      if (ts.isModuleDeclaration(node) && node.body && ts.isModuleBlock(node.body)) {
        node.body.statements.forEach(visit);
      }
      return;
    }

    const entry = toSurfaceEntry(node, source);
    if (entry) {
      const existing = into.get(entry.name);
      // Function overloads appear as sibling declarations; concatenating their
      // signatures means losing one is detected as a change.
      if (existing && existing.kind === entry.kind) {
        existing.signature = `${existing.signature} | ${entry.signature}`;
        existing.members = [...new Set([...existing.members, ...entry.members])];
        existing.requiredMembers = [...new Set([...existing.requiredMembers, ...entry.requiredMembers])];
      } else if (!existing) {
        into.set(entry.name, entry);
      }
    }

    if (ts.isModuleDeclaration(node) && node.body && ts.isModuleBlock(node.body)) {
      node.body.statements.forEach(visit);
    }
  };

  source.statements.forEach(visit);
  return into;
}

function isExported(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function toSurfaceEntry(node: ts.Node, source: ts.SourceFile): SurfaceEntry | null {
  if (ts.isFunctionDeclaration(node) && node.name) {
    return {
      name: node.name.text,
      kind: 'function',
      // The body is irrelevant to the contract; only the signature is.
      signature: collapse(node.getText(source).replace(/\{[\s\S]*$/, '')),
      members: [],
      requiredMembers: [],
    };
  }

  if (ts.isClassDeclaration(node) && node.name) {
    const members = node.members
      .filter((m) => !hasPrivateModifier(m))
      .map((m) => m.name?.getText(source))
      .filter((n): n is string => Boolean(n));
    return {
      name: node.name.text,
      kind: 'class',
      signature: collapse(signatureOfClassLike(node, source)),
      members,
      requiredMembers: node.members
        .filter((m) => ts.isPropertyDeclaration(m) && !m.questionToken && !hasPrivateModifier(m))
        .map((m) => m.name?.getText(source))
        .filter((n): n is string => Boolean(n)),
    };
  }

  if (ts.isInterfaceDeclaration(node)) {
    const members = node.members.map((m) => m.name?.getText(source)).filter((n): n is string => Boolean(n));
    const requiredMembers = node.members
      .filter((m) => (ts.isPropertySignature(m) || ts.isMethodSignature(m)) && !m.questionToken)
      .map((m) => m.name?.getText(source))
      .filter((n): n is string => Boolean(n));
    return {
      name: node.name.text,
      kind: 'interface',
      signature: collapse(node.getText(source)),
      members,
      requiredMembers,
    };
  }

  if (ts.isTypeAliasDeclaration(node)) {
    return {
      name: node.name.text,
      kind: 'type',
      signature: collapse(node.getText(source)),
      members: [],
      requiredMembers: [],
    };
  }

  if (ts.isEnumDeclaration(node)) {
    return {
      name: node.name.text,
      kind: 'enum',
      signature: collapse(node.getText(source)),
      members: node.members.map((m) => m.name.getText(source)),
      requiredMembers: [],
    };
  }

  if (ts.isVariableStatement(node)) {
    const declaration = node.declarationList.declarations[0];
    if (declaration && ts.isIdentifier(declaration.name)) {
      return {
        name: declaration.name.text,
        kind: 'variable',
        signature: collapse(node.getText(source)),
        members: [],
        requiredMembers: [],
      };
    }
  }

  if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
    return {
      name: node.name.text,
      kind: 'namespace',
      signature: `namespace ${node.name.text}`,
      members: [],
      requiredMembers: [],
    };
  }

  return null;
}

/** Class signature without the body — heritage and type params are the contract. */
function signatureOfClassLike(node: ts.ClassDeclaration, source: ts.SourceFile): string {
  const name = node.name?.text ?? '';
  const typeParams = node.typeParameters?.map((p) => p.getText(source)).join(', ') ?? '';
  const heritage = node.heritageClauses?.map((h) => h.getText(source)).join(' ') ?? '';
  return `class ${name}${typeParams ? `<${typeParams}>` : ''} ${heritage}`.trim();
}

function hasPrivateModifier(member: ts.ClassElement): boolean {
  const modifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined;
  if (modifiers?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)) return true;
  return member.name?.getText().startsWith('#') ?? false;
}

function collapse(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Diff two type surfaces.
 *
 * Only *removals and tightenings* are reported. Additions are non-breaking by
 * construction and reporting them would flood the plan with noise that a
 * reviewer then has to filter — which is how trust in a tool like this dies.
 */
export function diffSurfaces(before: SurfaceApi, after: SurfaceApi): SurfaceChange[] {
  const changes: SurfaceChange[] = [];

  for (const [name, oldEntry] of before) {
    const newEntry = after.get(name);

    if (!newEntry) {
      changes.push({
        kind: 'export-removed',
        symbol: name,
        detail: `\`${name}\` is no longer exported (was a ${oldEntry.kind}).`,
        before: oldEntry.signature,
      });
      continue;
    }

    if (oldEntry.kind !== newEntry.kind) {
      changes.push({
        kind: 'kind-changed',
        symbol: name,
        detail: `\`${name}\` changed from a ${oldEntry.kind} to a ${newEntry.kind}.`,
        before: oldEntry.signature,
        after: newEntry.signature,
      });
      continue;
    }

    for (const member of oldEntry.members) {
      if (!newEntry.members.includes(member)) {
        changes.push({
          kind: 'member-removed',
          symbol: `${name}.${member}`,
          detail: `\`${name}.${member}\` was removed.`,
        });
      }
    }

    const wasRequired = new Set(oldEntry.requiredMembers);
    for (const member of newEntry.requiredMembers) {
      if (!wasRequired.has(member) && oldEntry.members.includes(member)) {
        changes.push({
          kind: 'member-now-required',
          symbol: `${name}.${member}`,
          detail: `\`${name}.${member}\` is now required; it was previously optional.`,
        });
      }
    }

    if (oldEntry.signature !== newEntry.signature && oldEntry.kind !== 'interface' && oldEntry.kind !== 'class') {
      changes.push({
        kind: 'signature-changed',
        symbol: name,
        detail: `The signature of \`${name}\` changed.`,
        before: oldEntry.signature,
        after: newEntry.signature,
      });
    }
  }

  return changes;
}
