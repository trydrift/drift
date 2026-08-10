"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import { ECOSYSTEM_LABEL, type Recording } from "@/lib/recordings";
import { ECOSYSTEM_CAPABILITIES, type SupportTier } from "@/lib/capabilities";
import { AnalysisPanel } from "./analysis-panel";

/**
 * Pick a language, watch the real thing.
 *
 * The tab strip is the argument. A visitor who works in Go does not want to be
 * told Drift supports Go — they want to see it read a `go.mod` and name a
 * symbol in a file they could go and open. So the ecosystems are not a feature
 * list with checkmarks; each one is a button that plays a recording of that
 * ecosystem being analysed, and the repository is named so the claim can be
 * checked.
 *
 * Switching tabs resets the player rather than continuing where the last one
 * was, because a half-played recording of a different repository is a lie about
 * how far the new one has got.
 *
 * Each tab carries the depth Drift claims for that ecosystem, computed in
 * `src/detect/capabilities.ts` and synced into the site. A visitor picking the
 * CocoaPods tab should know before they press play that this is the ecosystem
 * where Drift cannot run a verification, rather than inferring it from a panel
 * that says less than the others did.
 */

const TIER_DOT: Record<SupportTier, string> = {
  deep: "bg-brand",
  strong: "bg-brand/55",
  working: "bg-amber-500/70",
  limited: "bg-faint/50",
};

const TIER_TITLE: Record<SupportTier, string> = {
  deep: "Deep support: computed API diff, published module names, runnable verification.",
  strong: "Strong support: two of the three.",
  working: "Working support: one of the three.",
  limited: "Limited support: detected and researched; the judgement is yours.",
};

const TIER_BY_ECOSYSTEM = new Map(
  ECOSYSTEM_CAPABILITIES.map((capability) => [capability.ecosystem, capability.tier]),
);
export function Demo({ recordings }: { recordings: Recording[] }) {
  const [active, setActive] = useState(recordings[0]?.id ?? "");
  const current = recordings.find((r) => r.id === active) ?? recordings[0];

  if (!current) return null;

  return (
    <div>
      {/* Horizontally scrollable on every width, so sixteen ecosystems never
          wrap into a five-row block that pushes the panel below the fold. */}
      <div
        className="-mx-4 mb-4 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0"
        role="tablist"
        aria-label="Sample analyses by ecosystem"
      >
        <div className="flex w-max gap-2">
          {recordings.map((recording) => {
            const selected = recording.id === current.id;
            return (
              <button
                key={recording.id}
                role="tab"
                aria-selected={selected}
                onClick={() => setActive(recording.id)}
                className={cn(
                  "flex shrink-0 flex-col items-start gap-0.5 rounded-xl border px-3.5 py-2 text-left transition-colors",
                  selected
                    ? "border-brand/45 bg-brand-soft"
                    : "border-border bg-surface/50 hover:bg-surface-hover",
                )}
              >
                <span
                  className={cn(
                    "flex items-center gap-1.5 text-[13px] font-medium",
                    selected ? "text-brand-text" : "text-foreground",
                  )}
                >
                  <span
                    aria-hidden
                    title={TIER_TITLE[TIER_BY_ECOSYSTEM.get(recording.ecosystem) ?? "limited"]}
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      TIER_DOT[TIER_BY_ECOSYSTEM.get(recording.ecosystem) ?? "limited"],
                    )}
                  />
                  {recording.language}
                </span>
                <span className="font-mono text-[10px] text-faint">
                  {ECOSYSTEM_LABEL[recording.ecosystem] ?? recording.ecosystem}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <p className="mb-3 text-sm text-muted">
        <a
          href={current.repo}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-brand-text underline decoration-dotted underline-offset-4"
        >
          {current.repo.replace("https://github.com/", "")}
        </a>{" "}
        — {current.blurb}
      </p>

      {/* Keyed so switching ecosystems remounts the panel: the player's timers,
          cursor and expanded row all belong to one recording. */}
      <AnalysisPanel key={current.id} recording={current} />
    </div>
  );
}
