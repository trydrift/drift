import { basename, type DependencyMap, type ManifestParser } from './types.js';
import type { DependencyKind } from '../../types.js';

export const mavenParser: ManifestParser = {
  ecosystem: 'maven',
  name: 'maven/gradle',

  handles(path) {
    const base = basename(path);
    return (
      base === 'pom.xml' ||
      base === 'build.gradle' ||
      base === 'build.gradle.kts' ||
      base === 'libs.versions.toml' ||
      base === 'gradle.lockfile'
    );
  },

  isLockfile(path) {
    return basename(path) === 'gradle.lockfile';
  },

  parse(content, path) {
    const base = basename(path);
    if (base === 'pom.xml') return parsePom(content);
    if (base === 'gradle.lockfile') return parseGradleLock(content);
    if (base === 'libs.versions.toml') return parseVersionCatalog(content);
    return parseGradleBuild(content);
  },
};

/**
 * Maven POMs.
 *
 * Versions are frequently `${property}` references, so we resolve against the
 * `<properties>` block and `dependencyManagement`. An unresolved property
 * yields `null`, which downstream treats as "version unknown" rather than
 * inventing one.
 */
function parsePom(content: string): DependencyMap {
  const out: DependencyMap = new Map();
  const properties = parseProperties(content);

  for (const match of content.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const block = match[1]!;
    const groupId = tag(block, 'groupId');
    const artifactId = tag(block, 'artifactId');
    if (!groupId || !artifactId) continue;

    const version = resolveProperties(tag(block, 'version'), properties);
    const scope = tag(block, 'scope');
    const optional = tag(block, 'optional') === 'true';

    const kind: DependencyKind = optional
      ? 'optional'
      : scope === 'test' || scope === 'provided'
        ? 'dev'
        : 'runtime';

    out.set(`${groupId}:${artifactId}`, { version, kind });
  }

  return out;
}

function parseProperties(content: string): Map<string, string> {
  const props = new Map<string, string>();
  for (const block of content.matchAll(/<properties>([\s\S]*?)<\/properties>/g)) {
    for (const entry of block[1]!.matchAll(/<([\w.-]+)>([^<]*)<\/\1>/g)) {
      props.set(entry[1]!, entry[2]!.trim());
    }
  }
  return props;
}

function resolveProperties(value: string | null, props: Map<string, string>): string | null {
  if (!value) return null;
  // Two passes handle one level of indirection, which covers real-world POMs
  // without risking a cycle.
  let resolved = value;
  for (let i = 0; i < 2; i++) {
    resolved = resolved.replace(/\$\{([^}]+)\}/g, (whole, key: string) => props.get(key) ?? whole);
  }
  return resolved.includes('${') ? null : resolved.trim() || null;
}

function tag(block: string, name: string): string | null {
  return new RegExp(`<${name}>([^<]*)</${name}>`).exec(block)?.[1]?.trim() ?? null;
}

/** Gradle `implementation 'group:artifact:version'` and the map form. */
function parseGradleBuild(content: string): DependencyMap {
  const out: DependencyMap = new Map();
  const configs =
    '(?:implementation|api|compileOnly|runtimeOnly|testImplementation|testCompileOnly|annotationProcessor|kapt|ksp)';

  for (const match of content.matchAll(
    new RegExp(`${configs}\\s*\\(?\\s*["']([^"']+:[^"']+)["']`, 'g'),
  )) {
    const parts = match[1]!.split(':');
    if (parts.length < 2) continue;
    const [group, artifact, version] = parts;
    const isTest = /test|androidTest/i.test(match[0]);
    out.set(`${group}:${artifact}`, {
      version: version ?? null,
      kind: isTest ? 'dev' : 'runtime',
    });
  }

  for (const match of content.matchAll(
    new RegExp(`${configs}\\s*\\(?\\s*group:\\s*["']([^"']+)["'],\\s*name:\\s*["']([^"']+)["'](?:,\\s*version:\\s*["']([^"']+)["'])?`, 'g'),
  )) {
    out.set(`${match[1]}:${match[2]}`, {
      version: match[3] ?? null,
      kind: /test/i.test(match[0]) ? 'dev' : 'runtime',
    });
  }

  return out;
}

/** Gradle version catalogs pin `group:artifact` under `[libraries]`. */
function parseVersionCatalog(content: string): DependencyMap {
  const out: DependencyMap = new Map();
  const versions = new Map<string, string>();

  let section = '';
  for (const raw of content.split('\n')) {
    const line = raw.split('#')[0]!.trim();
    if (!line) continue;
    const header = /^\[([^\]]+)\]$/.exec(line)?.[1];
    if (header) {
      section = header;
      continue;
    }

    if (section === 'versions') {
      const kv = /^([\w.-]+)\s*=\s*["']([^"']+)["']/.exec(line);
      if (kv) versions.set(kv[1]!, kv[2]!);
      continue;
    }

    if (section !== 'libraries') continue;

    const module = /module\s*=\s*["']([^"']+)["']/.exec(line)?.[1];
    const group = /group\s*=\s*["']([^"']+)["']/.exec(line)?.[1];
    const name = /name\s*=\s*["']([^"']+)["']/.exec(line)?.[1];
    const coordinate = module ?? (group && name ? `${group}:${name}` : null);
    if (!coordinate) continue;

    const literal = /version\s*=\s*["']([^"']+)["']/.exec(line)?.[1];
    const ref = /version\.ref\s*=\s*["']([^"']+)["']/.exec(line)?.[1];
    const version = literal ?? (ref ? versions.get(ref) ?? null : null);
    out.set(coordinate, { version, kind: 'runtime' });
  }

  return out;
}

function parseGradleLock(content: string): DependencyMap {
  const out: DependencyMap = new Map();
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // `group:artifact:version=configuration,configuration`
    const coordinate = line.split('=')[0]!;
    const parts = coordinate.split(':');
    if (parts.length < 3) continue;
    out.set(`${parts[0]}:${parts[1]}`, { version: parts[2]!, kind: 'transitive' });
  }
  return out;
}
