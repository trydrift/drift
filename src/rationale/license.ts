import type { Ecosystem } from '../types.js';
import { fetchVersionInfo, type RepositoryStatus, type VersionInfo } from '../evidence/registry.js';
import type { LicensePolicy } from '../config/schema.js';
import type { LicenseFinding } from './types.js';

/**
 * License changes that bear on an upgrade decision.
 *
 * Scoped tightly on purpose. Drift is not a compliance platform and does not
 * hold an inventory of what a repository depends on — it looks at one upgrade
 * and answers whether *taking it* changes the licensing position. A package
 * that has always been AGPL and is staying AGPL is not this tool's business;
 * one that was MIT last week and is AGPL in the version being proposed is
 * exactly this tool's business, because that is a decision being made right
 * now, silently, inside a version bump.
 *
 * Nothing here is a legal conclusion. The output is "this changed, and it
 * conflicts with the policy you configured" — which is a fact about a config
 * file, and is the most a program should say.
 */

/** How many newly-introduced dependencies are looked up. */
const MAX_INTRODUCED_LOOKUPS = 12;

export interface LicenseInput {
  name: string;
  ecosystem: Ecosystem;
  from: string;
  to: string;
  currentVersion: VersionInfo | null;
  targetVersion: VersionInfo | null;
  repository: RepositoryStatus | null;
  policy: LicensePolicy;
}

export async function assessLicense(input: LicenseInput): Promise<LicenseFinding> {
  const { name, currentVersion, targetVersion, repository, policy } = input;

  const before = currentVersion?.license ?? null;
  // The registry is the declaration that ships; GitHub's detection is a
  // fallback for ecosystems that publish no license metadata at all.
  const after = targetVersion?.license ?? repository?.license ?? null;

  const introduced = policy.enabled ? await introducedDependencies(input) : [];
  const allowed = (license: string | null) => isAllowed(license, policy);
  const violating = introduced.filter((dep) => !dep.allowed);
  const introducedStatement = () =>
    `This upgrade newly introduces ${violating.map((d) => `${d.name} (${d.license ?? 'no declared license'})`).join(', ')}, which the repository policy does not permit.`;

  if (!after && !before) {
    // requireDeclared means a missing license is itself a violation, and that
    // must be checked before the "nothing to report" shortcut below — the
    // whole point of the flag is to stop a missing license from going quiet.
    if (!allowed(after) || violating.length > 0) {
      const parts: string[] = [];
      if (!allowed(after)) {
        parts.push(
          `Neither ${name} ${input.from} nor ${input.to} declares a license Drift could read. The repository policy requires a declared license.`,
        );
      }
      if (violating.length > 0) parts.push(introducedStatement());
      parts.push(`The policy permits ${describePolicy(policy)}.`);
      return { verdict: 'policy-violation', statement: parts.join(' '), introduced };
    }

    // With no policy configured there is nothing this could have violated, and
    // "Go publishes no license metadata" printed against every Go dependency is
    // noise that trains people to skip the section. Only a repository that
    // asked for license checking is told they came back empty.
    return {
      verdict: policy.enabled ? 'unknown' : 'ok',
      statement: policy.enabled
        ? `Neither ${name} ${input.from} nor ${input.to} declares a license Drift could read, so this upgrade's licensing position could not be checked.`
        : 'No license metadata was published for either version.',
      introduced,
    };
  }

  if (before && after && !equivalent(before, after)) {
    // A license change and a newly denied introduced dependency can both be
    // true of the same upgrade; check both before deciding this is merely
    // 'changed', so neither can hide behind the other's early return.
    const ownViolation = !allowed(after);
    if (ownViolation || violating.length > 0) {
      const parts: string[] = [];
      parts.push(
        ownViolation
          ? `The declared license changed from ${before} to ${after}, which the repository policy does not permit.`
          : `The declared license changed from ${before} to ${after}.`,
      );
      if (violating.length > 0) parts.push(introducedStatement());
      parts.push(`The policy permits ${describePolicy(policy)}.`);
      return { verdict: 'policy-violation', from: before, to: after, statement: parts.join(' '), introduced };
    }
    return {
      verdict: 'changed',
      from: before,
      to: after,
      statement: `The declared license changed from ${before} to ${after}. It remains within this repository's configured policy.`,
      introduced,
    };
  }

  if (!allowed(after)) {
    return {
      verdict: 'policy-violation',
      ...(before ? { from: before } : {}),
      ...(after ? { to: after } : {}),
      statement: after
        ? `${name} is licensed ${after}, which the repository policy does not permit. The policy permits ${describePolicy(policy)}.`
        : `${name} ${input.to} declares no license Drift could read, though ${input.from} declared ${before}. The repository policy requires a declared license.`,
      introduced,
    };
  }

  if (violating.length > 0) {
    return {
      verdict: 'policy-violation',
      ...(before ? { from: before } : {}),
      ...(after ? { to: after } : {}),
      statement: `${introducedStatement()} The policy permits ${describePolicy(policy)}.`,
      introduced,
    };
  }

  if (!after) {
    // A license that was declared and now is not is worth reporting whether or
    // not a policy is configured: something changed, and it is not visible in
    // the diff of any file this repository owns.
    return {
      verdict: 'unknown',
      ...(before ? { from: before } : {}),
      statement: `${name} ${input.to} declares no license Drift could read, though ${input.from} declared ${before}.`,
      introduced,
    };
  }

  return {
    verdict: 'ok',
    ...(before ? { from: before } : {}),
    to: after,
    statement: `The license is unchanged at ${after}.`,
    introduced,
  };
}

/**
 * Dependencies the target version pulls in that the current one did not.
 *
 * Only the upgraded package's own direct dependencies: resolving a full
 * transitive graph would mean running the package manager, which analysis must
 * never do. This is the subset that can be read from published metadata, and
 * the report says so rather than implying whole-graph coverage.
 */
async function introducedDependencies(
  input: LicenseInput,
): Promise<LicenseFinding['introduced']> {
  const { currentVersion, targetVersion, ecosystem, policy } = input;
  if (!currentVersion || !targetVersion) return [];

  const had = new Set(currentVersion.dependencies);
  const added = targetVersion.dependencies
    .filter((dep) => !had.has(dep))
    .slice(0, MAX_INTRODUCED_LOOKUPS);
  if (added.length === 0) return [];

  const resolved = await Promise.all(
    added.map(async (dep) => {
      // The newest published version is the one a fresh install resolves to,
      // and is the closest available answer without running a resolver.
      const info = await fetchVersionInfo(dep, ecosystem, 'latest').catch(() => null);
      const license = info?.license ?? null;
      return { name: dep, license, allowed: isAllowed(license, policy) };
    }),
  );

  return resolved;
}

/**
 * Is this license permitted?
 *
 * A denylist entry always wins over an allowlist. An unreadable license is
 * permitted unless the policy explicitly asks otherwise — refusing an upgrade
 * because a registry field was empty is a false alarm, and false alarms are how
 * a policy check gets switched off.
 */
export function isAllowed(license: string | null, policy: LicensePolicy): boolean {
  if (!policy.enabled) return true;
  if (!license) return !policy.requireDeclared;

  const identifiers = splitExpression(license);

  if (policy.deny.length > 0 && identifiers.some((id) => matches(id, policy.deny))) return false;
  if (policy.allow.length === 0) return true;

  // A disjunction — `MIT OR Apache-2.0` — is satisfied by any permitted branch,
  // because the consumer chooses. This is the common dual-licensing shape in
  // the Rust ecosystem and refusing it would be simply wrong.
  return license.includes(' OR ')
    ? identifiers.some((id) => matches(id, policy.allow))
    : identifiers.every((id) => matches(id, policy.allow));
}

/** SPDX expressions: `MIT`, `MIT OR Apache-2.0`, `(MIT AND BSD-3-Clause)`. */
function splitExpression(license: string): string[] {
  return license
    .replace(/[()]/g, ' ')
    .split(/\s+(?:OR|AND|WITH)\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

function matches(identifier: string, list: readonly string[]): boolean {
  const needle = identifier.toLowerCase().replace(/\+$/, '');
  return list.some((entry) => entry.toLowerCase().replace(/\+$/, '') === needle);
}

/** Two spellings of the same license. `MIT` and `mit`; `Apache 2.0` and `Apache-2.0`. */
function equivalent(a: string, b: string): boolean {
  const normalise = (value: string) => value.toLowerCase().replace(/[\s._]/g, '-').replace(/-+/g, '-');
  return normalise(a) === normalise(b);
}

function describePolicy(policy: LicensePolicy): string {
  if (policy.allow.length > 0) return policy.allow.join(', ');
  if (policy.deny.length > 0) return `anything except ${policy.deny.join(', ')}`;
  return 'no licenses in particular';
}
