import type { DependencyKind } from '../../types.js';
import { basename, type DependencyMap, type ManifestParser } from './types.js';

/**
 * Scala — `build.sbt` and the `project/*.scala` files it reads.
 *
 * Scala is not a separate ecosystem, and treating it as one would be a mistake
 * that costs real coverage: sbt coordinates resolve to Maven Central artifacts.
 * Reporting them as `maven` means Scala upgrades get that ecosystem's registry
 * lookups, its japicmp surface diff, and its OSV advisories for free, instead
 * of a new ecosystem with none of the three.
 *
 * The `%%` operator is what makes this more than a regex. `"org.typelevel" %%
 * "cats-core" % "2.10.0"` does not depend on `cats-core` — it depends on
 * `cats-core_2.13`, with the Scala binary version appended. Getting that wrong
 * produces a Maven Central lookup for an artifact that has never existed, and
 * therefore an upgrade Drift reports as unverifiable. So `scalaVersion` is read
 * first and the suffix is applied, exactly as sbt would.
 */
export const sbtParser: ManifestParser = {
  ecosystem: 'maven',
  name: 'sbt',

  handles(path) {
    const base = basename(path);
    if (base.endsWith('.sbt')) return true;
    // `project/Dependencies.scala` is the conventional home for a dependency
    // list too large to keep inline, and `project/plugins.sbt` is matched by
    // the `.sbt` rule above.
    return /(^|\/)project\/[\w-]+\.scala$/.test(path.toLowerCase());
  },

  // sbt has no lockfile by default. `build.sbt` is the manifest, full stop.
  isLockfile() {
    return false;
  },

  parse(content) {
    return parseSbt(content);
  },
};

/**
 * The Scala binary version a full version maps to.
 *
 * Scala 2 keeps `major.minor` (2.13.12 → 2.13) because 2.13 and 2.12 are
 * binary-incompatible; Scala 3 keeps just `3`, because 3.x promises binary
 * compatibility across the line. This is sbt's own rule, not an approximation.
 */
export function binaryScalaVersion(full: string): string {
  const parts = full.trim().split('.');
  if (parts[0] === '3') return '3';
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : full.trim();
}

function parseSbt(content: string): DependencyMap {
  const out: DependencyMap = new Map();

  const scalaVersion = /\bscalaVersion\s*(?::=|\+=)\s*"([^"]+)"/.exec(content)?.[1];
  const suffix = scalaVersion ? `_${binaryScalaVersion(scalaVersion)}` : '';

  // `val`-bound version strings, so `"org" %% "lib" % catsVersion` resolves.
  const constants = new Map<string, string>();
  for (const match of content.matchAll(/\bval\s+([A-Za-z_]\w*)\s*=\s*"([^"]+)"/g)) {
    constants.set(match[1]!, match[2]!);
  }

  // `"group" %(%) "artifact" % version [% "scope"]`, where version is a string
  // literal or an identifier bound above.
  const pattern =
    /"([\w.-]+)"\s*(%%%|%%|%)\s*"([\w.-]+)"\s*%\s*(?:"([^"]+)"|([A-Za-z_]\w*))((?:\s*%\s*"[A-Za-z]+")?)/g;

  for (const match of content.matchAll(pattern)) {
    const group = match[1]!;
    const operator = match[2]!;
    const artifact = match[3]!;
    const literalVersion = match[4];
    const identifier = match[5];
    const scope = match[6] ?? '';

    // `%%%` is scala.js / Scala Native cross-building. The published artifact
    // carries a platform suffix Drift cannot reconstruct from the build file
    // alone, so the bare artifact name is recorded rather than a wrong one.
    const name = operator === '%%' ? `${group}:${artifact}${suffix}` : `${group}:${artifact}`;

    const version = literalVersion ?? (identifier ? (constants.get(identifier) ?? null) : null);

    const kind: DependencyKind = /"(test|it)"/i.test(scope)
      ? 'dev'
      : /"provided"/i.test(scope)
        ? 'dev'
        : /"optional"/i.test(scope)
          ? 'optional'
          : 'runtime';

    out.set(name, { version, kind });
  }

  // `addSbtPlugin("org" % "artifact" % "1.2.3")` — build-time only.
  for (const match of content.matchAll(
    /addSbtPlugin\s*\(\s*"([\w.-]+)"\s*%\s*"([\w.-]+)"\s*%\s*"([^"]+)"/g,
  )) {
    out.set(`${match[1]}:${match[2]}`, { version: match[3]!, kind: 'dev' });
  }

  return out;
}
