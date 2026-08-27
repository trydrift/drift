"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import {
  ECOSYSTEM_LABEL,
  describeSeverity,
  overallConfidenceLabel,
  severityOf,
  shortDate,
  totalsOf,
  type BreakingChange,
  type Candidate,
  type EvidenceRef,
  type ImpactSite,
  type Recording,
  type UpgradeSeverity,
} from "@/lib/recordings";
import { REPLAY_SPEEDS, type ReplaySpeed, usePlayer } from "./use-player";

/**
 * The panel.
 *
 * Modelled on the extension's dependency view, because the point of the demo is
 * to show what using Drift is actually like — a visitor who installs it after
 * watching this should recognise what they get. Same ordering (findings first),
 * same verdicts, same insistence that "could not check" is its own answer and
 * not a quiet kind of safe, and the same two actions offered on a row.
 *
 * Colour follows one rule, which is the reason the palette can be green at all:
 * green means checked and fine, amber means we could not see, and a finding is
 * neutral-with-emphasis rather than red. Nothing on this page is an emergency —
 * it is a report — and a wall of red would say the opposite of what the tool
 * exists to say.
 */

const VERDICT_STYLE: Record<UpgradeSeverity, string> = {
  affected: "border-brand/45 bg-brand-soft text-brand-text",
  "verification-failed": "border-brand/45 bg-brand-soft text-brand-text",
  "upstream-only": "border-border bg-surface-hover text-muted",
  unchecked: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  clean: "border-border bg-surface-hover text-faint",
  error: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  // A row the scan has listed and not yet checked. The demo never renders one
  // — it shows a finished report — but the verdict exists in the extension, so
  // it is styled here as the absence of a verdict rather than left to fall
  // through to whatever `clean` looks like.
  pending: "border-border bg-surface-hover text-faint",
};

/** The short form for the pill. `describeSeverity` writes the long one. */
const VERDICT_PILL: Record<UpgradeSeverity, string> = {
  affected: "Affects You",
  "verification-failed": "Verified Breaking",
  "upstream-only": "None Used Here",
  unchecked: "Not Verified",
  clean: "Safe",
  error: "Could Not Check",
  pending: "Checking",
};

const CONFIDENCE_STYLE: Record<ImpactSite["confidence"], string> = {
  high: "bg-brand-soft text-brand-text",
  medium: "bg-amber-500/12 text-amber-700 dark:text-amber-400",
  low: "bg-surface-hover text-faint",
};

/** Same rule as `CONFIDENCE_STYLE`, keyed by the overall band instead of a per-site one. */
const OVERALL_STYLE: Record<"high" | "medium" | "low" | "none", string> = {
  high: "bg-brand-soft text-brand-text",
  medium: "bg-amber-500/12 text-amber-700 dark:text-amber-400",
  low: "bg-surface-hover text-faint",
  none: "bg-surface-hover text-faint",
};

function overallBand(change: BreakingChange): "high" | "medium" | "low" | "none" {
  return change.overall?.band ?? change.confidence;
}

/** Permalink to the exact line, at the exact commit that was analysed. */
export function sourceUrl(recording: Recording, site: ImpactSite): string {
  return `${recording.repo}/blob/${recording.commit}/${site.file}#L${site.line}`;
}

function repoFileUrl(recording: Recording, path: string): string {
  return `${recording.repo}/blob/${recording.commit}/${path}`;
}

export function AnalysisPanel({ recording }: { recording: Recording }) {
  const { state, start, reset, currentProgress, speed, speedMultiplier, setSpeedMultiplier } =
    usePlayer(recording);
  const totals = useMemo(() => totalsOf(recording), [recording]);
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState(false);

  const root = useRef<HTMLDivElement>(null);
  const autoStarted = useRef(false);

  /**
   * Play it without being asked — but only once it can be seen.
   *
   * A visitor should not have to work out that the panel is interactive before
   * the product will show them anything. The demo is the argument, and an
   * argument that waits to be clicked mostly does not get made. Autoplaying
   * blind would be worse though: the panel sits below the fold, so the whole
   * run would finish into a viewport nobody was looking at, and the visitor
   * would scroll down to a static list of results having missed the part that
   * shows the work happening.
   *
   * Switching ecosystems remounts this component (see the `key` in `demo.tsx`),
   * which resets the guard and plays the new recording from its first event —
   * which is what "reselect a tab and watch it again" means.
   */
  useEffect(() => {
    const node = root.current;
    if (!node || autoStarted.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting || autoStarted.current) continue;
          autoStarted.current = true;
          observer.disconnect();
          start();
        }
      },
      // Enough of the panel to be worth watching, but low enough that a short
      // viewport can still reach the threshold.
      { threshold: 0.3 },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [start]);

  const replay = () => {
    setOpen(null);
    setNote(false);
    reset();
    // One frame, so the reset paints before the run restarts — otherwise
    // replaying a finished recording looks like nothing happened.
    requestAnimationFrame(() => start());
  };

  const done = state.phase === "done";
  const running = state.phase === "running";
  const visible = done ? recording.candidates : state.candidates;
  const affected = recording.candidates.filter((c) => severityOf(c) === "affected");
  const safe = recording.candidates.filter((c) => {
    const severity = severityOf(c);
    return severity === "clean" || severity === "upstream-only";
  });

  return (
    <div
      ref={root}
      // The run resizes this panel on a timer while a visitor may still be
      // scrolling past it; the browser's scroll anchoring overcorrects for
      // that into a visible jump, so this panel opts out of it.
      style={{ overflowAnchor: "none" }}
      className="overflow-hidden rounded-2xl border border-border bg-surface/60 shadow-lg backdrop-blur-sm"
    >
      {/* Title bar — editor chrome, so the panel reads as a tool rather than a
          marketing card. */}
      <div className="flex items-center gap-3 border-b border-border bg-surface-hover/60 px-4 py-2.5">
        <div className="flex gap-1.5" aria-hidden>
          <span className="size-2.5 rounded-full bg-faint/25" />
          <span className="size-2.5 rounded-full bg-faint/25" />
          <span className="size-2.5 rounded-full bg-faint/25" />
        </div>
        <span className="truncate font-mono text-[11px] text-faint sm:text-xs">
          drift outdated — {recording.repo.replace("https://github.com/", "")}
        </span>
        <span className="ml-auto hidden shrink-0 rounded-full border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-faint sm:inline">
          {ECOSYSTEM_LABEL[recording.ecosystem] ?? recording.ecosystem}
        </span>
      </div>

      {/* Status line */}
      <div className="border-b border-border px-4 py-3.5 sm:px-5">
        {state.phase === "idle" && (
          <div className="flex flex-wrap items-center gap-3">
            <button onClick={start} className="group flex min-w-0 flex-1 items-center gap-3 text-left">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand text-brand-foreground transition-transform group-hover:scale-105">
                <PlayIcon />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">
                  Analysing {recording.label}…
                </span>
                <span className="block truncate text-xs text-faint">
                  {recording.packagesChecked} direct dependencies · recorded{" "}
                  {shortDate(recording.capturedAt)}
                </span>
              </span>
            </button>
            <SpeedControl value={speedMultiplier} onChange={setSpeedMultiplier} />
          </div>
        )}

        {running && (
          <div className="flex flex-wrap items-center gap-3">
            <span className="size-2.5 shrink-0 rounded-full bg-brand orb" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-foreground">{currentProgress?.phase ?? "Starting"}</p>
              <p className="truncate font-mono text-[11px] text-faint">
                {currentProgress?.detail ?? recording.repo.replace("https://github.com/", "")}
              </p>
            </div>
            <span className="shrink-0 tabular text-xs text-faint">
              {currentProgress && currentProgress.total > 0
                ? `${currentProgress.done}/${currentProgress.total}`
                : `${(state.elapsed / 1000).toFixed(1)}s`}
            </span>
            <SpeedControl value={speedMultiplier} onChange={setSpeedMultiplier} />
          </div>
        )}

        {done && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <button
              onClick={replay}
              aria-label="Replay analysis"
              className="group flex size-11 shrink-0 items-center justify-center rounded-full border border-brand/40 bg-brand-soft text-brand-text transition-colors hover:bg-brand hover:text-brand-foreground"
            >
              <ReplayIcon className="transition-transform group-hover:-rotate-45" />
            </button>
            {/* A repository with nothing to upgrade is a real result and the
                most common one on a well-maintained project. Rendering it as
                "0 packages · 0 affect this code" made a correct answer look
                like a failed run, which is the same category of mistake as
                showing a gap as a pass — just in the other direction. */}
            {totals.packages === 0 ? (
              <p className="min-w-56 flex-1 text-sm text-foreground">
                <span className="font-medium">{recording.packagesChecked}</span> direct
                dependenc{recording.packagesChecked === 1 ? "y" : "ies"} checked ·{" "}
                <span className="font-medium text-brand-text">every one already current</span>
              </p>
            ) : (
              <p className="min-w-56 flex-1 text-sm text-foreground">
                <span className="font-medium">{totals.packages}</span> packages ·{" "}
                <span className="font-medium text-brand-text">{totals.affected}</span> affect this
                code
                {totals.breaking > totals.sites && (
                  <span className="text-muted">
                    {" "}
                    · {totals.breaking} upstream breaking change
                    {totals.breaking === 1 ? "" : "s"} found, most of them irrelevant here
                  </span>
                )}
              </p>
            )}
            <SpeedControl value={speedMultiplier} onChange={setSpeedMultiplier} />
            {safe.length > 1 && (
              <button
                onClick={() => setNote(true)}
                className="rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-surface-hover"
              >
                Upgrade all {safe.length}
              </button>
            )}
            {affected.length > 0 && (
              <button
                onClick={() => setNote(true)}
                className="rounded-md bg-brand px-2.5 py-1 text-xs font-medium text-brand-foreground transition-colors hover:bg-brand-200"
              >
                Fix all {affected.length} · {totals.sites} sites
              </button>
            )}
          </div>
        )}

        {/* Progress rail. Determinate once the scan knows its total. */}
        <div className="mt-3 h-0.75 overflow-hidden rounded-full bg-surface-hover">
          {running && (!currentProgress || currentProgress.total === 0) ? (
            <div className="indeterminate h-full w-full" />
          ) : (
            <div
              className="h-full rounded-full bg-brand transition-[width] duration-300 ease-out"
              style={{
                width: done
                  ? "100%"
                  : currentProgress && currentProgress.total > 0
                    ? `${Math.round((currentProgress.done / currentProgress.total) * 100)}%`
                    : "0%",
              }}
            />
          )}
        </div>

        {/* Says plainly that the buttons cannot do anything here. A demo button
            that silently does nothing is the kind of small dishonesty a page
            about evidence cannot afford. */}
        {note && (
          <p className="animate-rise mt-3 rounded-lg border border-brand/25 bg-brand-soft px-3 py-2 text-xs leading-relaxed text-muted">
            In your editor this installs selected upgrades, opens a branch when fixes are needed,
            and hands affected code to your agent — one commit per concern.{" "}
            <a href="#install" className="font-medium text-brand-text underline underline-offset-2">
              Run It on Your Own Repository
            </a>{" "}
            to see it act; this page is a recording, so there is nothing here to change.
          </p>
        )}
      </div>

      {/* Results */}
      <div className="max-h-104 overflow-y-auto overscroll-contain">
        {visible.length === 0 && !done && (
          <div className="space-y-2 p-4 sm:p-5" aria-hidden>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="skeleton h-11 rounded-lg border border-border bg-surface/50" />
            ))}
          </div>
        )}

        <ul className="divide-y divide-border">
          {visible.map((candidate) => {
            return (
              <PackageRow
                key={candidate.id}
                candidate={candidate}
                recording={recording}
                expanded={open === candidate.id}
                onToggle={() => setOpen(open === candidate.id ? null : candidate.id)}
                onAct={() => setNote(true)}
                interactive={done}
              />
            );
          })}
        </ul>
      </div>

      {/* Provenance. The claim that this is a real run is only worth making if
          it can be checked, so the commit and the real duration are printed. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border bg-surface-hover/40 px-4 py-2.5 font-mono text-[10px] text-faint sm:px-5 sm:text-[11px]">
        <a
          href={`${recording.repo}/tree/${recording.commit}`}
          target="_blank"
          rel="noreferrer"
          className="underline decoration-dotted underline-offset-2 transition-colors hover:text-brand-text"
        >
          {recording.commit.slice(0, 9)}
        </a>
        <span>·</span>
        <span>
          real run took {formatDuration(recording.durationMs)}, replayed at {speed}×
        </span>
        <span className="hidden sm:inline">·</span>
        <span className="hidden sm:inline">
          whole repository, {recording.packagesChecked} package
          {recording.packagesChecked === 1 ? "" : "s"}, no sampling
        </span>
        {recording.nestedGitRepos && recording.nestedGitRepos.length > 0 && (
          <>
            <span className="hidden sm:inline">·</span>
            <span title={recording.nestedGitRepos.join(", ")}>
              {recording.nestedGitRepos.length} nested git repo
              {recording.nestedGitRepos.length === 1 ? "" : "s"} kept separate
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function SpeedControl({
  value,
  onChange,
}: {
  value: ReplaySpeed;
  onChange: (speed: ReplaySpeed) => void;
}) {
  return (
    <div
      className="flex shrink-0 items-center gap-1 rounded-full border border-border bg-surface px-1 py-1"
      role="group"
      aria-label="Replay speed"
    >
      {REPLAY_SPEEDS.map((speed) => (
        <button
          key={speed}
          type="button"
          onClick={() => onChange(speed)}
          aria-pressed={value === speed}
          className={cn(
            "min-w-8 rounded-full px-2 py-1 font-mono text-[10px] font-semibold tabular transition-colors",
            value === speed
              ? "bg-brand text-brand-foreground"
              : "text-faint hover:bg-surface-hover hover:text-foreground",
          )}
        >
          {speed}×
        </button>
      ))}
    </div>
  );
}

/**
 * `14.3s`, `23m 04s`. A whole-repository run of GitLab really does take
 * twenty-three minutes, and printing that as `1383.8s` buries the one number
 * that explains why the replay is compressed at all.
 */
function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 90) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
}

function PackageRow({
  candidate,
  recording,
  expanded,
  onToggle,
  onAct,
  interactive,
}: {
  candidate: Candidate;
  recording: Recording;
  expanded: boolean;
  onToggle: () => void;
  onAct: () => void;
  interactive: boolean;
}) {
  const verdict = severityOf(candidate);
  const hasDetail = candidate.breaking.length > 0;
  const canExpand = interactive && (hasDetail || candidate.current !== candidate.selected || candidate.gaps.length > 0);
  const manifestPath = candidate.manifestPath ?? null;
  const location = packageLocation(candidate);

  return (
    <li className="animate-rise">
      <button
        onClick={canExpand ? onToggle : undefined}
        disabled={!canExpand}
        className={cn(
          "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors sm:px-5",
          canExpand && "cursor-pointer hover:bg-surface-hover",
        )}
      >
        <div className="min-w-0 flex-1">
          {/* Wraps rather than truncates on a narrow screen: a Go module path
              or a scoped npm name is mostly prefix, and truncating it leaves
              the developer looking at `@radix-ui/react-…`, which identifies
              nothing. The version pair moves to its own line instead. */}
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="break-all font-mono text-[13px] font-medium text-foreground">
              {candidate.name}
            </span>
            {location && (
              <span
                className="rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-faint"
                title={manifestPath ? `Declared in ${manifestPath}` : location}
              >
                {location}
              </span>
            )}
            <span className="tabular font-mono text-[11px] text-faint">
              {candidate.current} → {candidate.selected}
            </span>
          </div>
          {/* Drift's own sentence about this package, not a rephrasing — it is
              already written to lead with what the developer has to do. */}
          <p className="mt-0.5 line-clamp-2 text-xs text-muted sm:line-clamp-1">
            {!interactive && (candidate.status === "pending" || candidate.status === "checking") && candidate.phase
              ? candidate.phase
              : describeSeverity(candidate)}
          </p>
        </div>

        <span
          className={cn(
            "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide",
            VERDICT_STYLE[verdict],
          )}
        >
          {verdict === "affected"
            ? `${candidate.impactCount} site${candidate.impactCount === 1 ? "" : "s"}`
            : verdict === "upstream-only"
              ? `${candidate.breakingCount} upstream`
              : VERDICT_PILL[verdict]}
        </span>

        {canExpand && (
          <ChevronIcon
            className={cn("shrink-0 text-faint transition-transform", expanded && "rotate-90")}
          />
        )}
      </button>

      {expanded && (
        <div className="space-y-3 border-t border-border bg-surface-hover/30 px-4 py-4 sm:px-5">
          {manifestPath && (
            <p className="font-mono text-[11px] text-faint">
              Declared in{" "}
              <a
                href={repoFileUrl(recording, manifestPath)}
                target="_blank"
                rel="noreferrer"
                className="underline decoration-dotted underline-offset-2 transition-colors hover:text-brand-text"
              >
                {manifestPath}
              </a>
            </p>
          )}

          {/* The two things a developer does next, in the extension's own
              words: take the version, or fix what taking it would break. */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={onAct}
              className="rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-[11px] text-foreground transition-colors hover:bg-surface-hover"
            >
              Upgrade to {candidate.selected}
            </button>
            {(candidate.actionableImpactCount ?? 0) > 0 && (
              <button
                onClick={onAct}
                className="rounded-md bg-brand px-2.5 py-1.5 text-[11px] font-medium text-brand-foreground transition-colors hover:bg-brand-200"
              >
                Fix {candidate.actionableImpactCount} site{candidate.actionableImpactCount === 1 ? "" : "s"} in{" "}
                {candidate.actionableImpactFiles ?? 0} file{candidate.actionableImpactFiles === 1 ? "" : "s"}
              </button>
            )}
            {candidate.safeLatest && candidate.safeLatest !== candidate.selected && (
              <span className="font-mono text-[10px] text-faint">
                {candidate.safeLatest} stays inside the declared range
              </span>
            )}
          </div>

          {candidate.breaking.map((change, index) => (
            <div key={index}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-surface-hover px-1.5 py-0.5 font-mono text-[10px] text-faint">
                  {change.kind}
                </span>
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] font-medium",
                    OVERALL_STYLE[overallBand(change)],
                  )}
                  title="How confident Drift is overall, combining whether the change really happened upstream, whether it reaches this repository, and whether anything confirmed it."
                >
                  {overallConfidenceLabel(change)}
                </span>
                <span className="text-xs font-medium text-foreground">{change.summary}</span>
              </div>
              {change.remediation && (
                <CodeAwareText text={change.remediation} className="mt-1 text-xs leading-relaxed text-muted" />
              )}
              <EvidenceLinks evidence={change.evidence ?? []} />
              {change.sites.length > 0 && (
                // Horizontal scroll is contained here rather than on the page:
                // a long source line must never widen the document on a phone.
                <div className="mt-2 overflow-x-auto rounded-lg border border-border bg-(--pre-bg)">
                  <table className="w-full min-w-88 border-collapse text-left font-mono text-[11px]">
                    <tbody>
                      {change.sites.map((site, i) => (
                        <tr key={i} className="border-b border-border/60 last:border-0">
                          {/* `w-px` + `whitespace-nowrap` collapses this column
                              to its content so the code sits next to the
                              location rather than half a panel away. */}
                          <td className="w-px whitespace-nowrap px-2.5 py-1.5 align-top">
                            {/* Straight to that line, at the commit that was
                                analysed. "Trust us, line 130" is a claim; a
                                link a reader opens in one click is evidence. */}
                            <a
                              href={sourceUrl(recording, site)}
                              target="_blank"
                              rel="noreferrer"
                              className="text-faint underline decoration-dotted underline-offset-2 transition-colors hover:text-brand-text"
                            >
                              {site.file}:{site.line}
                            </a>
                          </td>
                          <td className="px-2.5 py-1.5 align-top text-foreground">{site.excerpt}</td>
                          <td className="whitespace-nowrap px-2.5 py-1.5 align-top">
                            <span
                              className={cn(
                                "rounded px-1.5 py-0.5 text-[10px]",
                                CONFIDENCE_STYLE[site.confidence],
                              )}
                            >
                              {site.confidence}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
          {candidate.gaps.length > 0 && (
            <p className="text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
              Incomplete: {candidate.gaps[0]}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

type TextSegment =
  | { kind: "paragraph"; text: string }
  | { kind: "code"; label: "before" | "after"; code: string };

function CodeAwareText({ text, className }: { text: string; className?: string }) {
  const segments = useMemo(() => parseTextSegments(text), [text]);

  return (
    <div className={cn("space-y-2", className)}>
      {segments.map((segment, index) =>
        segment.kind === "paragraph" ? (
          <p key={index}>
            <InlineCode text={segment.text} />
          </p>
        ) : (
          <figure key={index} className="overflow-hidden rounded-md border border-border bg-(--pre-bg)">
            <figcaption className="border-b border-border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide text-faint">
              {segment.label}
            </figcaption>
            <pre className="overflow-x-auto wrap-break-word p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground">
              <code>{segment.code}</code>
            </pre>
          </figure>
        ),
      )}
    </div>
  );
}

function InlineCode({ text }: { text: string }) {
  return text.split(/(`[^`]+`)/g).map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={index} className="rounded bg-surface-hover px-1 py-0.5 font-mono text-[0.92em] text-foreground">
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={index}>{part}</span>;
  });
}

function parseTextSegments(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const paragraph: string[] = [];

  const flushParagraph = () => {
    const value = paragraph.join(" ").trim();
    paragraph.length = 0;
    if (value) segments.push({ kind: "paragraph", text: value });
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const labelledCode = /^(before|after):\s*(.*)$/i.exec(line);
    if (labelledCode) {
      flushParagraph();
      segments.push({
        kind: "code",
        label: labelledCode[1]!.toLowerCase() as "before" | "after",
        code: labelledCode[2]!,
      });
      continue;
    }

    if (!line) {
      flushParagraph();
      continue;
    }
    paragraph.push(line);
  }

  flushParagraph();
  return segments.length ? segments : [{ kind: "paragraph", text }];
}

function packageLocation(candidate: Pick<Candidate, "manifestPath" | "workspace" | "workspaceName">): string | null {
  if (candidate.workspaceName) return candidate.workspaceName;
  if (candidate.workspace) return candidate.workspace;

  const manifest = candidate.manifestPath;
  if (!manifest || !manifest.includes("/")) return null;
  return manifest.slice(0, manifest.lastIndexOf("/"));
}

function EvidenceLinks({ evidence }: { evidence: EvidenceRef[] }) {
  const visible = evidence.filter((entry) => entry.url || entry.locator);
  if (visible.length === 0) return null;

  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-faint">
      <span>Evidence:</span>
      {visible.map((entry, index) => {
        const label = `${entry.source}: ${entry.title}`;
        const separator = index < visible.length - 1 ? <span aria-hidden>·</span> : null;
        return (
          <span key={`${entry.source}:${entry.title}:${index}`} className="inline-flex items-center gap-1.5">
            {entry.url ? (
              <a
                href={entry.url}
                target="_blank"
                rel="noreferrer"
                className="underline decoration-dotted underline-offset-2 transition-colors hover:text-brand-text"
              >
                {label}
              </a>
            ) : (
              <span title={entry.locator ?? undefined}>{label}</span>
            )}
            {separator}
          </span>
        );
      })}
    </p>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="size-4 translate-x-px" aria-hidden>
      <path d="M8 5.14v13.72a.5.5 0 0 0 .76.43l11.2-6.86a.5.5 0 0 0 0-.86L8.76 4.71A.5.5 0 0 0 8 5.14Z" />
    </svg>
  );
}

function ReplayIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-4", className)}
      aria-hidden
    >
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
      <path d="m10 9 5 3-5 3V9Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-4", className)}
      aria-hidden
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}
