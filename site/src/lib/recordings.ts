/**
 * The recordings, and what they mean.
 *
 * Everything the page shows comes from `src/data/*.json`, written by
 * `scripts/capture.mjs` from real runs against real repositories. Nothing here
 * computes a finding, invents a version, or smooths a number — the only work
 * this file does is describe the shape that arrived and give the UI a couple of
 * derived views over it.
 *
 * The files are imported statically rather than fetched so the whole page,
 * recordings included, is one static download with no request waterfall and no
 * loading state to design around.
 */

export interface ProgressEvent {
  /** Milliseconds after the run began. Real elapsed time, not a designed curve. */
  at: number;
  phase: string;
  detail: string;
  done: number;
  total: number;
}

export interface ImpactSite {
  file: string;
  line: number;
  excerpt: string;
  matchedSymbol: string;
  confidence: "high" | "medium" | "low";
}

export interface BreakingChange {
  kind: string;
  summary: string;
  remediation: string;
  confidence: "high" | "medium" | "low";
  symbols: string[];
  sites: ImpactSite[];
}

export interface Candidate {
  name: string;
  ecosystem: string;
  current: string;
  latest: string;
  selected: string;
  safeLatest: string | null;
  status: string;
  risk: string;
  summary: string;
  recommendation: string | null;
  breakingCount: number;
  impactCount: number;
  impactFiles: number;
  evidenceCount: number;
  gaps: string[];
  breaking: BreakingChange[];
}

export interface LatentFinding {
  kind: "unreviewed-drift" | "range-violation";
  dependency: string;
  declaredRange: string;
  rangeFloor: string;
  installedVersion: string;
  summary: string;
  remediation: string | null;
  sites: ImpactSite[];
}

export interface Recording {
  id: string;
  label: string;
  ecosystem: string;
  language: string;
  repo: string;
  blurb: string;
  capturedAt: string;
  commit: string;
  durationMs: number;
  packagesChecked: number;
  manifests: string[];
  events: ProgressEvent[];
  candidates: Candidate[];
  audit: { checked: number; analysed: number; findings: LatentFinding[] } | null;
}

/**
 * The verdict, from Drift itself.
 *
 * `severityOf` is imported from the core package rather than reimplemented
 * here — it is deliberately dependency-free for exactly this reason, and the
 * first version of this file got it wrong in a way that matters. It collapsed
 * "a hundred upstream changes, none of which touch you" into a generic pass,
 * which is the single most valuable thing Drift has to say, and it ignored the
 * rationale's own conclusion, so packages whose API had been compared symbol
 * by symbol were labelled unverified while their own summary said they were
 * fine. The site now reaches the same verdict as the extension by running the
 * same function over the same fields.
 */
import {
  severityOf as coreSeverityOf,
  describeSeverity as coreDescribeSeverity,
  type SeverityInput,
  type UpgradeSeverity,
} from "./severity";

export type { UpgradeSeverity };

/**
 * A captured candidate, in the shape the core verdict expects.
 *
 * The only difference is `recommendation`: JSON has no `undefined`, so the
 * recording stores `null` where the core type uses an absent field. Adapting
 * here rather than loosening the core type keeps the change where the format
 * mismatch actually is.
 */
function asSeverityInput(candidate: Candidate): SeverityInput {
  return { ...candidate, recommendation: candidate.recommendation ?? undefined };
}

export function severityOf(candidate: Candidate): UpgradeSeverity {
  return coreSeverityOf(asSeverityInput(candidate));
}

export function describeSeverity(candidate: Candidate): string {
  return coreDescribeSeverity(asSeverityInput(candidate));
}

/** Language tag shown on a tab, in the words the ecosystem's users use. */
export const ECOSYSTEM_LABEL: Record<string, string> = {
  npm: "npm",
  pypi: "PyPI",
  go: "Go modules",
  cargo: "crates.io",
  maven: "Maven",
  rubygems: "RubyGems",
  nuget: "NuGet",
  conan: "ConanCenter",
  vcpkg: "vcpkg",
  arduino: "Arduino Library Manager",
  packagist: "Packagist",
  hex: "Hex",
  pub: "pub.dev",
  swift: "Swift Package Manager",
  cocoapods: "CocoaPods",
  opam: "opam",
};

/**
 * The recording, condensed to what the summary bar counts.
 *
 * Computed once per recording rather than per frame — these totals never change
 * during a replay, and recomputing them on every animation tick was the
 * difference between a smooth panel and a janky one on a phone.
 */
export interface Totals {
  packages: number;
  affected: number;
  clean: number;
  unchecked: number;
  breaking: number;
  sites: number;
  files: number;
}

export function totalsOf(recording: Recording): Totals {
  const verdicts = recording.candidates.map(severityOf);
  const files = new Set(
    recording.candidates.flatMap((c) => c.breaking.flatMap((b) => b.sites.map((s) => s.file))),
  );

  return {
    packages: recording.candidates.length,
    affected: verdicts.filter((v) => v === "affected").length,
    // "Upstream-only" counts as clean for the summary bar: it is a package the
    // developer does not have to touch, which is the question the bar answers.
    clean: verdicts.filter((v) => v === "clean" || v === "upstream-only").length,
    unchecked: verdicts.filter((v) => v === "unchecked").length,
    breaking: recording.candidates.reduce((sum, c) => sum + c.breakingCount, 0),
    sites: recording.candidates.reduce((sum, c) => sum + c.impactCount, 0),
    files: files.size,
  };
}

/** `1699…` -> `2 Nov 2025`, for the "captured on" line under the panel. */
export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
