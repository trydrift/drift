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

export const RECORDING_SCHEMA_VERSION = 2;

export interface ProgressTimelineEvent {
  type: "progress";
  /** Milliseconds after the run began. Real elapsed time, not a designed curve. */
  at: number;
  phase: string;
  detail: string;
  done: number;
  total: number;
}
export type RecordingTimelineEvent = ProgressTimelineEvent | { type: "candidate-upsert"; at: number; candidate: Candidate } | { type: "candidate-drop"; at: number; id: string };

export interface ImpactSite {
  file: string;
  line: number;
  excerpt: string;
  matchedSymbol: string;
  confidence: "high" | "medium" | "low";
}

export interface EvidenceRef {
  source: string;
  title: string;
  url: string | null;
  locator: string | null;
}

interface RuntimeRequirementBase {
  runtime: "node" | "python" | "go" | "ruby" | "java" | "rust";
  requirement: string;
  sourceText: string;
  rangeParseStatus?: "parsed" | "unknown";
}

export type RuntimeRequirement =
  | (RuntimeRequirementBase & { kind: "minimum-runtime" })
  | (RuntimeRequirementBase & { kind: "unsupported-runtime-range"; derivedMinimum?: string });

/** The single customer-facing number — see `deriveOverallConfidence` in core. */
export interface OverallConfidence {
  score: number;
  band: "high" | "medium" | "low" | "none";
  label: string;
}

export interface BreakingChange {
  kind: string;
  summary: string;
  remediation: string;
  confidence: "high" | "medium" | "low";
  /**
   * Absent on recordings captured before this field existed, and `null` for
   * the rare finding with no assessment to derive it from. Both render the
   * same way: fall back to a label for the plain `confidence` band above,
   * rather than a fabricated number.
   */
  overall?: OverallConfidence | null;
  runtime?: RuntimeRequirement | null;
  symbols: string[];
  evidence?: EvidenceRef[];
  sites: ImpactSite[];
}

export interface Candidate {
  id: string;
  name: string;
  ecosystem: string;
  manifestPath?: string;
  workspace?: string | null;
  workspaceName?: string | null;
  current: string;
  latest: string;
  selected: string;
  safeLatest: string | null;
  status: string;
  phase: string | null;
  risk: string;
  summary: string;
  recommendation: string | null;
  /**
   * What Drift established about this repository's runtime for this upgrade's
   * runtime requirements. `null` when it announced none — deliberately not
   * `"compatible"`, since "nothing asked" is not "asked and satisfied".
   * Absent in recordings captured before the state existed.
   */
  runtimeCompatibility?: "compatible" | "incompatible" | "partial" | "unknown" | null;
  /** The per-requirement breakdown behind {@link runtimeCompatibility}. */
  runtimeAnalyses?: {
    changeId: string;
    runtime: string;
    state: "compatible" | "incompatible" | "partial" | "unknown";
    reason: string;
    siteCount: number;
    declarationCount: number;
    unresolvedCount: number;
  }[];
  severity?: "affected" | "verification-failed" | "review-required" | "runtime-unresolved" | "evidence-missing" | "upstream-only" | "clean" | "error" | "pending";
  independentActionableFindingCount?: number;
  actionableImpactCount?: number;
  actionableImpactFiles?: number;
  runtimeDeclarationSiteCount?: number;
  sourceCoverage?: {
    sourceFilesDiscovered: number;
    sourceFilesIndexed: number;
    sourceTruncated: boolean;
    runtimeConfigsDiscovered: number;
    runtimeConfigsIndexed: number;
  };
  /** Complete runtime-finding identity set; unlike `breaking`, never sliced. */
  runtimeChanges?: { id: string; runtime: RuntimeRequirement["runtime"] }[];
  dispositions?: {
    changeId: string;
    state: "actionable" | "review-only" | "unaffected" | "unknown";
    reason: string;
    siteCount: number;
    actionableSiteCount: number;
    runtimeState: "compatible" | "incompatible" | "partial" | "unknown" | null;
  }[];
  breakingCount: number;
  impactCount: number;
  impactFiles: number;
  evidenceCount: number;
  gaps: string[];
  breaking: BreakingChange[];
}

export interface Recording {
  schemaVersion: number;
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
  nestedGitRepos?: string[];
  timeline: RecordingTimelineEvent[];
  candidates: Candidate[];
}

/**
 * Whether a capture has the candidate lifecycle that the extension shows.
 *
 * Older captures stored every intermediate update in their final `candidates`
 * array. Replaying one as though it were a finished report duplicates rows and
 * makes old `checking` states look like verdicts, so it is not a safe fallback.
 */
export function normalizeRecording(raw: unknown): Recording | null {
  if (!raw || typeof raw !== "object") return null;
  const recording = raw as Partial<Recording>;
  if (
    recording.schemaVersion !== RECORDING_SCHEMA_VERSION ||
    !Array.isArray(recording.timeline) ||
    !Array.isArray(recording.candidates)
  ) {
    return null;
  }
  return recording as Recording;
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
} from "./severity.ts";

export type { UpgradeSeverity };

/**
 * A captured candidate, in the shape the core verdict expects.
 *
 * Two differences from the recorded JSON. `recommendation`: JSON has no
 * `undefined`, so the recording stores `null` where the core type uses an
 * absent field. And `impactConfidence`: recordings predate that field, so it
 * is derived here from the per-site confidence already present in every
 * capture, the same way `scan.ts` derives it live — the strongest band across
 * every site on every breaking change, so a recording with only textual
 * matches still gets the hedged "May affect" wording rather than reading as
 * unhedged just because it is old data.
 */
function asSeverityInput(candidate: Candidate): SeverityInput {
  const confidences = candidate.breaking.flatMap((b) => b.sites.map((s) => s.confidence));
  const impactConfidence = confidences.includes("high")
    ? "high"
    : confidences.includes("medium")
      ? "medium"
      : confidences.includes("low")
        ? "low"
        : "none";
  // Same `null`-for-absent translation as `recommendation`: an upgrade with
  // no runtime requirement records `null`, and `severityOf` must see an
  // absent field rather than a state it would have to interpret.
  const { runtimeCompatibility, ...rest } = candidate;
  return {
    ...rest,
    recommendation: candidate.recommendation ?? undefined,
    impactConfidence,
    ...(runtimeCompatibility ? { runtimeCompatibility } : {}),
  };
}

/** Mirrors `OVERALL_LABEL` in `src/confidence/types.ts`, for recordings with no stored score to read a label from. */
const BAND_LABEL: Record<"high" | "medium" | "low", string> = {
  high: "Very confident",
  medium: "Fairly confident",
  low: "Not very confident",
};

/**
 * The line a reader sees: a real "82/100 — Fairly confident" for a recording
 * captured with `overall` present, or just the label for an older one that
 * only has the plain band. Never invents a number for data that doesn't have
 * one.
 */
export function overallConfidenceLabel(change: BreakingChange): string {
  if (change.overall) return `${change.overall.score}/100 — ${change.overall.label}`;
  return BAND_LABEL[change.confidence];
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
  reviewRequired: number;
  runtimeUnknown: number;
  evidenceMissing: number;
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
    reviewRequired: verdicts.filter((v) => v === "review-required").length,
    runtimeUnknown: verdicts.filter((v) => v === "runtime-unresolved").length,
    evidenceMissing: verdicts.filter((v) => v === "evidence-missing").length,
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
