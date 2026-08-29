import type { Ecosystem } from '../types.js';
import { compareParsedVersions, parsePublishedVersion } from '../version-semantics.js';
import type {
  SecurityAssessment,
  SecurityDirection,
  Severity,
  Vulnerability,
} from './types.js';

/**
 * Known vulnerabilities, from OSV.
 *
 * OSV is the right primary source for Drift specifically because it is
 * per-ecosystem and version-range native: it answers "is *this* version
 * affected" directly, for npm, PyPI, Go, crates.io, Maven, and RubyGems alike,
 * which is exactly the shape of the question a dependency upgrade asks. GitHub
 * Advisories are in it, and so are the Go vulnerability database and RustSec.
 *
 * The question asked here is not "does this package have vulnerabilities" —
 * that is a scanner's question, and Drift is not a scanner. It is: *does taking
 * this specific upgrade improve, preserve, or worsen this repository's known
 * exposure?* Everything below exists to answer that one, and the result is
 * attached to the upgrade rather than collected into a dashboard.
 */

const OSV_QUERY = 'https://api.osv.dev/v1/query';
const OSV_QUERY_BATCH = 'https://api.osv.dev/v1/querybatch';
const OSV_VULN = 'https://api.osv.dev/v1/vulns';

/** OSV's ecosystem names. Not ours, and not guessable — they are enumerated. */
const OSV_ECOSYSTEM: Record<Ecosystem, string | null> = {
  npm: 'npm',
  pypi: 'PyPI',
  go: 'Go',
  cargo: 'crates.io',
  maven: 'Maven',
  rubygems: 'RubyGems',
  nuget: 'NuGet',
  packagist: 'Packagist',
  hex: 'Hex',
  pub: 'Pub',
  // OSV identifies Swift packages by their repository URL, which is exactly
  // what SwiftPM calls them — so the name Drift already carries is the query.
  swift: 'SwiftURL',
  // Genuinely absent from OSV. `null` makes the security stage report "not
  // checked here" rather than "no advisories", which are not the same claim.
  cocoapods: null,
  opam: null,
  // C and C++ vulnerabilities are catalogued against the upstream project, not
  // against the Conan recipe, the vcpkg port, or the Arduino library that
  // repackages it — OSV has no ecosystem for any of the three. `null` is the
  // honest answer, and it matters more here than elsewhere: this is the
  // ecosystem where a reader is most likely to assume that "no advisories"
  // means "no CVEs", when what it means is that the CVE is filed under a name
  // Drift was not given.
  conan: null,
  vcpkg: null,
  arduino: null,
};

interface OsvSeverity {
  type?: string;
  score?: string;
}

interface OsvEvent {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
}

interface OsvAffected {
  package?: { name?: string; ecosystem?: string };
  ranges?: { type?: string; events?: OsvEvent[] }[];
  versions?: string[];
  database_specific?: { severity?: string };
  ecosystem_specific?: { severity?: string };
}

interface OsvVuln {
  id?: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  withdrawn?: string;
  severity?: OsvSeverity[];
  affected?: OsvAffected[];
  references?: { type?: string; url?: string }[];
  database_specific?: { severity?: string };
}

/** Injected by tests. Production always uses `fetchJson`. */
export type OsvFetch = (url: string, body: unknown) => Promise<unknown | null>;
export type OsvBatchFetch = (queries: readonly OsvQuery[]) => Promise<readonly (unknown | null)[] | OsvFailure>;

export interface OsvOptions {
  fetch?: OsvFetch;
  batchFetch?: OsvBatchFetch;
}

export interface OsvQuery {
  version: string;
  package: { name: string; ecosystem: string };
  page_token?: string;
}

export interface SecurityLookup {
  name: string;
  ecosystem: Ecosystem;
  from: string;
  to: string;
}

/**
 * Compare the known vulnerability exposure of two versions of one package.
 *
 * Both versions are queried, because the interesting answers live in the
 * difference. A target version that fixes three advisories and introduces one
 * is a real trade-off a developer should be shown, and asking only about the
 * version they are on would hide it.
 */
export async function assessSecurity(
  name: string,
  ecosystem: Ecosystem,
  from: string,
  to: string,
  options: OsvOptions = {},
): Promise<SecurityAssessment> {
  const osvEcosystem = OSV_ECOSYSTEM[ecosystem];
  // Not a failure and never reported as one: OSV genuinely has no ecosystem for
  // these, so there was nothing to reach.
  if (!osvEcosystem) {
    return unchecked(
      `OSV has no advisory coverage for ${ecosystem} packages, so this upgrade's effect on known vulnerabilities could not be looked up.`,
    );
  }

  const query = options.fetch ?? defaultFetch;

  const [currentRaw, targetRaw] = await Promise.all([
    query(OSV_QUERY, osvQuery(name, osvEcosystem, from)),
    query(OSV_QUERY, osvQuery(name, osvEcosystem, to)),
  ]);

  return compareSecurityResponses(currentRaw, targetRaw, from, to, ecosystem);
}

/**
 * Query OSV for a group of upgrades in one request.
 *
 * OSV provides `/v1/querybatch` for this exact shape. Each dependency still
 * needs two questions — the installed version and the candidate version — but
 * batching turns a large rationale run from dozens of independent requests into
 * one small POST.
 */
export async function assessSecurityBatch(
  lookups: readonly SecurityLookup[],
  options: OsvOptions = {},
): Promise<Map<SecurityLookup, SecurityAssessment>> {
  const out = new Map<SecurityLookup, SecurityAssessment>();
  const covered: { lookup: SecurityLookup; osvEcosystem: string }[] = [];

  for (const lookup of lookups) {
    const osvEcosystem = OSV_ECOSYSTEM[lookup.ecosystem];
    if (!osvEcosystem) {
      out.set(
        lookup,
        unchecked(
          `OSV has no advisory coverage for ${lookup.ecosystem} packages, so this upgrade's effect on known vulnerabilities could not be looked up.`,
        ),
      );
    } else {
      covered.push({ lookup, osvEcosystem });
    }
  }

  if (covered.length === 0) return out;

  if (covered.length === 1 && !options.batchFetch) {
    const { lookup } = covered[0]!;
    out.set(lookup, await assessSecurity(lookup.name, lookup.ecosystem, lookup.from, lookup.to, options));
    return out;
  }

  if (options.fetch && !options.batchFetch) {
    const assessed = await Promise.all(
      covered.map(({ lookup }) => assessSecurity(lookup.name, lookup.ecosystem, lookup.from, lookup.to, options)),
    );
    covered.forEach(({ lookup }, index) => out.set(lookup, assessed[index]!));
    return out;
  }

  const queries = covered.flatMap(({ lookup, osvEcosystem }) => [
    osvQuery(lookup.name, osvEcosystem, lookup.from),
    osvQuery(lookup.name, osvEcosystem, lookup.to),
  ]);
  const batchFetch = options.batchFetch ?? defaultBatchFetch;
  const responses = await batchFetch(queries);

  if (isOsvFailure(responses)) {
    for (const { lookup } of covered) {
      out.set(
        lookup,
        unchecked(`${responses.osvFailure}, so this upgrade's effect on known vulnerabilities is unknown.`),
      );
    }
    return out;
  }

  for (let i = 0; i < covered.length; i += 1) {
    const currentRaw = responses[i * 2];
    const targetRaw = responses[i * 2 + 1];
    out.set(
      covered[i]!.lookup,
      compareSecurityResponses(
        currentRaw,
        targetRaw,
        covered[i]!.lookup.from,
        covered[i]!.lookup.to,
        covered[i]!.lookup.ecosystem,
      ),
    );
  }

  return out;
}

function compareSecurityResponses(
  currentRaw: unknown | null | undefined,
  targetRaw: unknown | null | undefined,
  from: string,
  to: string,
  ecosystem: Ecosystem,
): SecurityAssessment {
  // A network failure is not an all-clear. Both sides must have answered for
  // the comparison between them to mean anything — an empty `{}` body is an
  // answer, and means this version has no advisories.
  const failure = [currentRaw, targetRaw].find(isOsvFailure);
  if (currentRaw == null || targetRaw == null || failure) {
    return unchecked(
      failure
        ? `${failure.osvFailure}, so this upgrade's effect on known vulnerabilities is unknown.`
        : `The OSV advisory database could not be reached, so this upgrade's effect on known vulnerabilities is unknown.`,
    );
  }

  const current = readVulnerabilities(currentRaw, from, ecosystem);
  const target = readVulnerabilities(targetRaw, to, ecosystem);

  const resolved = current.filter((v) => !appearsIn(v, target));
  const introduced = target.filter((v) => !appearsIn(v, current));
  const carried = current.filter((v) => appearsIn(v, target));

  return {
    checked: true,
    current,
    target,
    resolved,
    introduced,
    carried,
    direction: describeDirection(resolved, introduced),
  };
}

function osvQuery(name: string, ecosystem: string, version: string): OsvQuery {
  return { version, package: { name, ecosystem } };
}

/**
 * Is this the same advisory as one in the other set?
 *
 * Matched on any shared identifier rather than on the primary id. Which record
 * OSV returns as primary varies between two queries for two versions of the
 * same package — one comes back led by its GHSA, the other by its GO- record —
 * and comparing primary ids reported lodash's Command Injection advisory as
 * simultaneously resolved by, and introduced by, the same upgrade.
 */
function appearsIn(vulnerability: Vulnerability, others: readonly Vulnerability[]): boolean {
  const identifiers = new Set([vulnerability.id, ...vulnerability.aliases]);
  return others.some(
    (other) => identifiers.has(other.id) || other.aliases.some((alias) => identifiers.has(alias)),
  );
}

function describeDirection(
  resolved: readonly Vulnerability[],
  introduced: readonly Vulnerability[],
): SecurityDirection {
  if (resolved.length > 0 && introduced.length > 0) return 'mixed';
  if (resolved.length > 0) return 'improves';
  if (introduced.length > 0) return 'worsens';
  return 'preserves';
}

export function unchecked(reason?: string): SecurityAssessment {
  return {
    checked: false,
    ...(reason ? { reason } : {}),
    current: [],
    target: [],
    resolved: [],
    introduced: [],
    carried: [],
    direction: 'unknown',
  };
}

/** Read an OSV query response into Drift's shape. Tolerates every field being absent. */
export function readVulnerabilities(payload: unknown, version: string, ecosystem: Ecosystem = 'npm'): Vulnerability[] {
  const vulns = (payload as { vulns?: OsvVuln[] } | null)?.vulns;
  if (!Array.isArray(vulns)) return [];

  const out: Vulnerability[] = [];
  for (const vuln of vulns) {
    // A withdrawn advisory is one the database itself no longer stands behind.
    if (!vuln.id || vuln.withdrawn) continue;
    out.push({
      id: vuln.id,
      aliases: (vuln.aliases ?? []).filter((a): a is string => typeof a === 'string'),
      summary: firstSentence(vuln.summary || vuln.details || 'No summary published.'),
      severity: readSeverity(vuln),
      url: advisoryUrl(vuln),
      fixedIn: firstFixedVersion(vuln, version, ecosystem),
    });
  }

  // Most serious first: a reader who stops after one line should have read the
  // one that mattered.
  return mergeAliases(out, ecosystem).sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/**
 * One advisory, listed once.
 *
 * OSV returns the same vulnerability under every database that carries it, so a
 * single Go HTTP/2 flaw arrives as GO-2024-2687 *and* GHSA-4v7x-pqxf-cx7m *and*
 * CVE-2023-45288, each cross-referencing the others. Reporting three
 * high-severity findings where there is one is the same failure as printing the
 * same error message twice, and it inflates every count downstream.
 *
 * Records are grouped transitively through their aliases. The representative is
 * the one that states a severity — the GitHub advisory usually does and the Go
 * record usually does not — and the group's identifiers are merged onto it, so
 * nothing a reader might search for is lost.
 */
export function mergeAliases(vulnerabilities: readonly Vulnerability[], ecosystem: Ecosystem = 'npm'): Vulnerability[] {
  const groupOf = new Map<string, number>();
  const groups: Vulnerability[][] = [];

  for (const vuln of vulnerabilities) {
    const keys = [vuln.id, ...vuln.aliases];
    const existing = keys.map((k) => groupOf.get(k)).find((g) => g !== undefined);
    const index = existing ?? groups.push([]) - 1;
    groups[index]!.push(vuln);
    for (const key of keys) groupOf.set(key, index);
  }

  return groups.filter((group) => group.length > 0).map((group) => {
    const lead = group.find((v) => v.severity !== 'unknown') ?? group[0]!;
    const identifiers = new Set(group.flatMap((v) => [v.id, ...v.aliases]));
    identifiers.delete(lead.id);

    return {
      ...lead,
      aliases: [...identifiers].sort(),
      // The lowest stated fix is the one that actually clears the advisory.
      fixedIn: lowestVersion(group.map((v) => v.fixedIn), ecosystem),
      summary: group.find((v) => v.summary !== 'No summary published.')?.summary ?? lead.summary,
    };
  });
}

function lowestVersion(versions: readonly (string | null)[], ecosystem: Ecosystem): string | null {
  const parsed = versions
    .filter((v): v is string => Boolean(v))
    .map((raw) => ({ raw, parsed: parsePublishedVersion(raw, ecosystem) }))
    .filter((v): v is { raw: string; parsed: NonNullable<typeof v.parsed> } => v.parsed !== null)
    .sort((a, b) => compareParsedVersions(a.parsed, b.parsed) ?? 0);
  return parsed[0]?.raw ?? versions.find((v): v is string => Boolean(v)) ?? null;
}

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  unknown: 4,
};

/**
 * The severity a database states, preferred over one Drift computes.
 *
 * GitHub and the Go database publish a plain band; everyone else publishes a
 * CVSS vector. The band is taken as written when present, because a maintainer
 * downgrading a theoretical CVSS 9.8 to "moderate in practice" knows something
 * the vector does not carry.
 */
export function readSeverity(vuln: OsvVuln): Severity {
  const stated =
    vuln.database_specific?.severity ??
    vuln.affected?.find((a) => a.database_specific?.severity)?.database_specific?.severity ??
    vuln.affected?.find((a) => a.ecosystem_specific?.severity)?.ecosystem_specific?.severity;

  if (stated) {
    const band = stated.toLowerCase();
    if (band === 'critical') return 'critical';
    if (band === 'high') return 'high';
    if (band === 'moderate' || band === 'medium') return 'medium';
    if (band === 'low') return 'low';
  }

  const vector = vuln.severity?.find((s) => s.score)?.score;
  const score = vector ? cvssBaseScore(vector) : null;
  if (score === null) return 'unknown';
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  return 'low';
}

/**
 * A CVSS v3 base score from its vector string.
 *
 * Implemented rather than pulled in as a dependency: it is the published
 * formula, it is forty lines, and a vulnerability checker that itself adds a
 * transitive dependency to every install of Drift is a poor advertisement.
 */
export function cvssBaseScore(vector: string): number | null {
  if (!/^CVSS:3\.[01]\//.test(vector)) return null;

  const metrics = new Map<string, string>();
  for (const part of vector.split('/').slice(1)) {
    const [key, value] = part.split(':');
    if (key && value) metrics.set(key, value);
  }

  const AV: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
  const AC: Record<string, number> = { L: 0.77, H: 0.44 };
  const UI: Record<string, number> = { N: 0.85, R: 0.62 };
  const CIA: Record<string, number> = { H: 0.56, L: 0.22, N: 0 };
  const scope = metrics.get('S') === 'C';
  // Privileges Required is scored differently when the scope changes.
  const PR: Record<string, number> = scope
    ? { N: 0.85, L: 0.68, H: 0.5 }
    : { N: 0.85, L: 0.62, H: 0.27 };

  const av = AV[metrics.get('AV') ?? ''];
  const ac = AC[metrics.get('AC') ?? ''];
  const pr = PR[metrics.get('PR') ?? ''];
  const ui = UI[metrics.get('UI') ?? ''];
  const c = CIA[metrics.get('C') ?? ''];
  const i = CIA[metrics.get('I') ?? ''];
  const a = CIA[metrics.get('A') ?? ''];
  if ([av, ac, pr, ui, c, i, a].some((v) => v === undefined)) return null;

  const impactBase = 1 - (1 - c!) * (1 - i!) * (1 - a!);
  const impact = scope
    ? 7.52 * (impactBase - 0.029) - 3.25 * (impactBase - 0.02) ** 15
    : 6.42 * impactBase;
  if (impact <= 0) return 0;

  const exploitability = 8.22 * av! * ac! * pr! * ui!;
  const base = Math.min(scope ? 1.08 * (impact + exploitability) : impact + exploitability, 10);

  // CVSS rounds up to one decimal place, always.
  return Math.ceil(base * 10) / 10;
}

/**
 * The first version at or after `version` that fixes this advisory.
 *
 * OSV expresses affectedness as introduced/fixed event pairs. The fix a
 * developer needs is the lowest `fixed` boundary that is actually ahead of
 * where they are — quoting a fix from a range they have already passed would
 * send them to a version that does not help.
 */
export function firstFixedVersion(vuln: OsvVuln, version: string, ecosystem: Ecosystem = 'npm'): string | null {
  const current = parsePublishedVersion(version, ecosystem);
  const candidates: string[] = [];

  for (const affected of vuln.affected ?? []) {
    for (const range of affected.ranges ?? []) {
      for (const event of range.events ?? []) {
        if (event.fixed) candidates.push(event.fixed);
      }
    }
  }
  if (candidates.length === 0) return null;

  const comparable = candidates
    .map((raw) => ({ raw, parsed: parsePublishedVersion(raw, ecosystem) }))
    .filter((c): c is { raw: string; parsed: NonNullable<typeof c.parsed> } => c.parsed !== null);

  if (!current || comparable.length === 0) return candidates[0] ?? null;

  const ahead = comparable
    .filter((c) => (compareParsedVersions(c.parsed, current) ?? -1) > 0)
    .sort((a, b) => compareParsedVersions(a.parsed, b.parsed) ?? 0);

  return (ahead[0] ?? comparable.sort((a, b) => compareParsedVersions(a.parsed, b.parsed) ?? 0)[0])?.raw ?? null;
}

/**
 * The advisory a reader should open.
 *
 * A reference the database marks as ADVISORY is the authoritative write-up;
 * OSV's own page is the fallback and always exists.
 */
export function advisoryUrl(vuln: OsvVuln): string {
  const advisory = vuln.references?.find((r) => r.type === 'ADVISORY' && r.url)?.url;
  return advisory ?? `https://osv.dev/vulnerability/${vuln.id}`;
}

function firstSentence(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const stop = collapsed.search(/\.\s|\.$/);
  const sentence = stop > 0 ? collapsed.slice(0, stop + 1) : collapsed;
  return sentence.length > 300 ? `${sentence.slice(0, 299)}…` : sentence;
}

/**
 * OSV takes a POST body, which the shared `fetchJson` helper does not do.
 *
 * Failures resolve to a typed failure rather than throwing, matching every
 * other evidence fetch: an unreachable OSV degrades the assessment to "not
 * checked" and must never fail a scan.
 */
const OSV_TIMEOUT_MS = 10_000;
const OSV_RETRIES = 2;
const OSV_BACKOFF_MS = 200;

/**
 * A failed lookup, carrying why.
 *
 * A bare `null` was indistinguishable between a timeout, a 429, and a DNS
 * failure, so every one of them was reported to the developer as "could not be
 * reached" — which sends someone hunting for a firewall when the real answer
 * was that OSV rate-limited a burst. Injected fetches may still return plain
 * `null`; that is still a failure, just an unexplained one.
 */
export interface OsvFailure {
  osvFailure: string;
  transient?: boolean;
}

export function isOsvFailure(raw: unknown): raw is OsvFailure {
  return typeof raw === 'object' && raw !== null && 'osvFailure' in raw;
}

const defaultFetch: OsvFetch = async (url, body) => {
  return requestOsvPost(url, body);
};

const defaultBatchFetch: OsvBatchFetch = async (queries) => {
  const results: { vulns: OsvVuln[] }[] = Array.from({ length: queries.length }, () => ({ vulns: [] }));
  let pending = queries.map((query, index) => ({ query, index }));

  while (pending.length > 0) {
    const raw = await requestOsvPost(OSV_QUERY_BATCH, { queries: pending.map((item) => item.query) });
    if (isOsvFailure(raw)) return raw;

    const page = (raw as { results?: ({ vulns?: OsvVuln[]; next_page_token?: string } | null)[] } | null)?.results;
    if (!Array.isArray(page) || page.length !== pending.length) {
      return { osvFailure: 'OSV returned a malformed batch response' };
    }

    const next: typeof pending = [];
    for (let i = 0; i < page.length; i += 1) {
      const item = pending[i]!;
      const pageResult = page[i] ?? {};
      results[item.index]!.vulns.push(...((pageResult.vulns ?? []).filter((v): v is OsvVuln => Boolean(v?.id))));
      if (pageResult.next_page_token) {
        next.push({ index: item.index, query: { ...item.query, page_token: pageResult.next_page_token } });
      }
    }
    pending = next;
  }

  const details = await fetchVulnerabilityDetails(results.flatMap((result) => result.vulns));
  if (isOsvFailure(details)) return details;

  return results.map((result) => ({
    vulns: result.vulns.map((vuln) => details.get(vuln.id!) ?? vuln),
  }));
};

async function fetchVulnerabilityDetails(vulns: readonly OsvVuln[]): Promise<Map<string, OsvVuln> | OsvFailure> {
  const ids = [...new Set(vulns.map((vuln) => vuln.id).filter((id): id is string => Boolean(id)))];
  const details = await Promise.all(
    ids.map(async (id): Promise<[string, OsvVuln] | OsvFailure> => {
      const raw = await requestOsvGet(`${OSV_VULN}/${encodeURIComponent(id)}`);
      if (isOsvFailure(raw)) return raw;
      return [id, raw as OsvVuln];
    }),
  );

  const failure = details.find(isOsvFailure);
  if (failure) return failure;

  return new Map(details as [string, OsvVuln][]);
}

async function requestOsvPost(url: string, body: unknown): Promise<unknown | OsvFailure> {
  return requestOsvJson(url, { method: 'POST', body: JSON.stringify(body) });
}

async function requestOsvGet(url: string): Promise<unknown | OsvFailure> {
  return requestOsvJson(url, { method: 'GET' });
}

async function requestOsvJson(
  url: string,
  init: { method: 'GET' } | { method: 'POST'; body: string },
): Promise<unknown | OsvFailure> {
  let lastFailure: OsvFailure | null = null;
  for (let attempt = 0; attempt <= OSV_RETRIES; attempt += 1) {
    const result = await requestOsvJsonOnce(url, init);
    if (!isOsvFailure(result) || !result.transient || attempt === OSV_RETRIES) return result;

    lastFailure = result;
    await sleep(OSV_BACKOFF_MS * 2 ** attempt);
  }
  return lastFailure ?? { osvFailure: 'OSV could not be reached (network error)' };
}

async function requestOsvJsonOnce(
  url: string,
  init: { method: 'GET' } | { method: 'POST'; body: string },
): Promise<unknown | OsvFailure> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OSV_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: init.method,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'drift-bot/0.1 (+https://github.com/trydrift/drift)',
      },
      ...(init.method === 'POST' ? { body: init.body } : {}),
    });
    if (!response.ok) {
      // 429 is the one worth naming outright: it is self-inflicted, it comes
      // and goes with how many packages a scan looks at, and it is the only
      // one the developer can do something about by scanning less at once.
      return {
        osvFailure:
          response.status === 429
            ? 'OSV rate-limited this scan (HTTP 429). Lowering `drift.analysis.concurrency` will fetch fewer advisories at once.'
            : `OSV answered HTTP ${response.status} ${response.statusText}`.trim(),
        transient: response.status === 408 || response.status === 429 || response.status >= 500,
      };
    }
    return (await response.json()) as unknown;
  } catch (err) {
    const error = err as Error;
    const timedOut = error?.name === 'AbortError' || error?.name === 'TimeoutError';
    return {
      osvFailure: timedOut
        ? `OSV did not answer within ${OSV_TIMEOUT_MS / 1000}s${causeSuffix(error)}`
        : `OSV could not be reached (${errorMessageWithCause(error)})`,
      transient: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

function errorMessageWithCause(err: Error | null | undefined): string {
  const message = err?.message || 'network error';
  return `${message}${causeSuffix(err)}`;
}

function causeSuffix(err: Error | null | undefined): string {
  const cause = (err as { cause?: unknown } | null | undefined)?.cause;
  if (cause === undefined || cause === null) return '';
  return `; cause: ${describeCause(cause)}`;
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message || cause.name;
  if (typeof cause === 'string') return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { OSV_ECOSYSTEM };
