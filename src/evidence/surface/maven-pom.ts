import type { SurfaceChange } from '../type-surface.js';

/**
 * A Maven artifact's role, and the consumer contract of the ones that are not
 * JARs.
 *
 * `org.springframework.boot:spring-boot-starter-parent` publishes no JAR, and
 * never has: it is `<packaging>pom</packaging>`, a parent whose entire purpose
 * is the dependency and plugin management it hands down. Asking Maven Central
 * for its JAR and reporting the 404 as an evidence gap says Drift looked for
 * the wrong artifact, not that the package is uninspectable.
 *
 * So packaging is read first, and only a JAR-shaped artifact goes to the
 * classfile differ. A POM is compared as what it is.
 */

/** What kind of artifact a Maven coordinate publishes. */
export type MavenPackaging =
  /** A classfile artifact the japicmp differ can read. */
  | 'jar'
  /** No code artifact; the POM itself is the contract (parents, BOMs). */
  | 'pom'
  /** A known packaging Drift has no comparison for. */
  | 'other';

export interface PomContract {
  /** The declared packaging, lowercased, exactly as written. */
  packaging: string;
  role: MavenPackaging;
  /** `groupId:artifactId` -> managed version, from `<dependencyManagement>`. */
  managedDependencies: Map<string, string>;
  /** `groupId:artifactId` -> managed version, from `<pluginManagement>`. */
  managedPlugins: Map<string, string>;
  /** `<properties>` a child POM can reference or override. */
  properties: Map<string, string>;
}

/** Packagings that still produce a classfile artifact japicmp can read. */
const JAR_PACKAGINGS = new Set(['jar', 'bundle', 'maven-plugin', 'ejb']);

export function parsePomContract(xml: string): PomContract {
  const project = elementBody(xml, 'project') ?? xml;
  const packaging = (elementBody(project, 'packaging') ?? 'jar').trim().toLowerCase() || 'jar';

  return {
    packaging,
    role: JAR_PACKAGINGS.has(packaging) ? 'jar' : packaging === 'pom' ? 'pom' : 'other',
    managedDependencies: coordinates(
      elementBody(elementBody(project, 'dependencyManagement') ?? '', 'dependencies') ?? '',
      'dependency',
    ),
    managedPlugins: coordinates(
      elementBody(elementBody(project, 'pluginManagement') ?? '', 'plugins') ?? '',
      'plugin',
    ),
    properties: properties(elementBody(project, 'properties') ?? ''),
  };
}

/**
 * What a consumer of this POM can no longer rely on.
 *
 * Deliberately narrow. A BOM raising a managed version is ordinary
 * maintenance, not a break, and Drift has no way to interpret an arbitrary
 * plugin configuration. What it can prove is disappearance: a managed
 * coordinate or an inherited property that a child POM referenced and that is
 * no longer there.
 */
export function diffPomContracts(before: PomContract, after: PomContract): SurfaceChange[] {
  const changes: SurfaceChange[] = [];

  for (const [coordinate, version] of before.managedDependencies) {
    if (after.managedDependencies.has(coordinate)) continue;
    changes.push({
      kind: 'package-removed',
      symbol: coordinate,
      detail: `${coordinate} is no longer managed by this POM, so a dependent that relied on the inherited version must now declare one`,
      before: version,
      after: '(unmanaged)',
    });
  }

  for (const [coordinate, version] of before.managedPlugins) {
    if (after.managedPlugins.has(coordinate)) continue;
    changes.push({
      kind: 'package-removed',
      symbol: coordinate,
      detail: `the ${coordinate} plugin is no longer managed by this POM, so a build that relied on the inherited configuration must now supply one`,
      before: version,
      after: '(unmanaged)',
    });
  }

  for (const [name, value] of before.properties) {
    if (after.properties.has(name)) continue;
    changes.push({
      kind: 'member-removed',
      symbol: `\${${name}}`,
      detail: `the inherited property \${${name}} was removed, so a child POM referencing it no longer resolves`,
      before: value,
    });
  }

  return changes;
}

/**
 * The body of the first `<name>` element.
 *
 * A hand-rolled reader rather than an XML parser: Drift reads four known
 * sections of a POM, and adding an XML dependency to do it would be a larger
 * commitment than the job. Self-closing and absent elements return null.
 */
function elementBody(xml: string, name: string): string | null {
  const open = new RegExp(`<${name}(\\s[^>]*)?>`, 'i').exec(xml);
  if (!open) return null;
  const start = open.index + open[0].length;
  const close = xml.indexOf(`</${name}>`, start);
  return close === -1 ? null : xml.slice(start, close);
}

/** Every `<dependency>`/`<plugin>` in a section, as `groupId:artifactId`. */
function coordinates(section: string, element: string): Map<string, string> {
  const out = new Map<string, string>();
  const pattern = new RegExp(`<${element}(?:\\s[^>]*)?>([\\s\\S]*?)</${element}>`, 'gi');
  for (const match of section.matchAll(pattern)) {
    const body = match[1]!;
    const groupId = elementBody(body, 'groupId')?.trim();
    const artifactId = elementBody(body, 'artifactId')?.trim();
    if (!artifactId) continue;
    // A managed plugin may omit its groupId, which Maven defaults.
    const group = groupId || (element === 'plugin' ? 'org.apache.maven.plugins' : '');
    if (!group) continue;
    out.set(`${group}:${artifactId}`, elementBody(body, 'version')?.trim() ?? '(inherited)');
  }
  return out;
}

function properties(section: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of section.matchAll(/<([\w.-]+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)) {
    out.set(match[1]!, match[2]!.trim());
  }
  return out;
}
