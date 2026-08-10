"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * What the GitHub Action does, as the sequence it actually is.
 *
 * The CLI and the extension both had something on this page that moves; the
 * Action — the way most teams would actually run Drift — had one sentence in a
 * card. That is backwards, because the Action is the only surface where Drift
 * acts without a human watching, and "acts without a human watching" is
 * precisely the claim a visitor needs to see bounded before they will enable
 * it.
 *
 * So this animates the whole run, ending on the thing that matters most: by
 * default it does not open a pull request at all. It files an issue and waits.
 *
 * The steps are the real ones, in the real order, with the real permissions
 * from `examples/workflows/drift.yml`.
 */

interface Step {
  /** What GitHub is doing, in its own vocabulary. */
  title: string;
  detail: string;
  /** A short line of evidence, rendered monospace. */
  trace: string;
}

const STEPS: Step[] = [
  {
    title: "A dependency file changes on main",
    detail:
      "The workflow triggers on manifests and lockfiles only, so it does not start on every push and do nothing.",
    trace: "on: push · paths: **/package.json, **/go.mod, **/vcpkg.json, …",
  },
  {
    title: "Drift analyses the diff",
    detail:
      "The same pipeline the CLI runs — evidence, breaking changes, and the lines in this repository that use them.",
    trace: "uses: trydrift/drift@v0",
  },
  {
    title: "A check run carries the verdict",
    detail:
      "Affected, upstream-only, or clean, with the count of files. It is a check, so it shows up where reviewers already look.",
    trace: "checks: write · status: affected · 3 files",
  },
  {
    title: "By default, it asks",
    detail:
      "A fresh install files an approval issue containing the plan and waits for a human to comment /drift apply. Autonomy is opt-in, per repository.",
    trace: "mode: approve · issue #482 opened",
  },
  {
    title: "Then a pull request that explains itself",
    detail:
      "One commit per concern, in dependency order, each resolved by a deterministic codemod, then a version-pinned community recipe, then an agent — never silently, and always in that order.",
    trace: "3 commits · every claim cites the evidence it came from",
  },
];

const STEP_MS = 2600;

export function ActionFlow() {
  const [active, setActive] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    // Reduced motion gets every step revealed at once rather than a panel that
    // sits on step one forever: the sequence is the content here, not decoration.
    if (query.matches) {
      setActive(STEPS.length - 1);
      return;
    }
    setPlaying(true);
  }, []);

  // Plays once and stops on the last step, rather than looping. A panel that
  // restarts forever is a distraction on a page someone is trying to read, and
  // the last step is the one worth leaving on screen anyway.
  useEffect(() => {
    if (!playing || active >= STEPS.length - 1) return;
    const timer = setTimeout(() => setActive((current) => current + 1), STEP_MS);
    return () => clearTimeout(timer);
  }, [playing, active]);

  const finished = active >= STEPS.length - 1;

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-surface/50">
      <div className="flex items-center gap-2 border-b border-border bg-surface-hover/40 px-4 py-2.5">
        <span className="size-2 rounded-full bg-brand" />
        <span className="font-mono text-[11px] text-faint">.github/workflows/drift.yml</span>
        {finished && playing ? (
          <button
            type="button"
            onClick={() => setActive(0)}
            className="ml-auto rounded-md px-1.5 py-0.5 font-mono text-[11px] text-faint transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            replay
          </button>
        ) : (
          <span className="ml-auto font-mono text-[11px] text-faint">
            {String(active + 1).padStart(2, "0")} / {String(STEPS.length).padStart(2, "0")}
          </span>
        )}
      </div>

      <ol className="divide-y divide-border">
        {STEPS.map((step, index) => {
          const done = index < active;
          const current = index === active;

          return (
            <li
              key={step.title}
              className={cn(
                "flex gap-3.5 px-4 py-3.5 transition-colors duration-500 sm:px-5",
                current && "bg-brand-soft/40",
              )}
            >
              <span
                className={cn(
                  "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-[10px] font-semibold transition-colors duration-500",
                  current
                    ? "border-brand/50 bg-brand-soft text-brand-text orb"
                    : done
                      ? "border-brand/30 bg-brand-soft/60 text-brand-text"
                      : "border-border bg-surface text-faint",
                )}
              >
                {done ? "✓" : index + 1}
              </span>

              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    "text-[13px] font-semibold transition-colors duration-500",
                    current || done ? "text-foreground" : "text-muted",
                  )}
                >
                  {step.title}
                </p>
                <p className="mt-1 text-[12.5px] leading-relaxed text-muted">{step.detail}</p>
                <p
                  className={cn(
                    "mt-1.5 break-words font-mono text-[10.5px] leading-relaxed transition-colors duration-500",
                    current ? "text-brand-text" : "text-faint",
                  )}
                >
                  {step.trace}
                </p>
              </div>
            </li>
          );
        })}
      </ol>

      {/* The progress of the current step, so the panel reads as running
          rather than as a list that happens to be tinted. */}
      <div className="h-0.5 w-full bg-border">
        <div
          key={active}
          className={cn("h-full bg-brand", playing && !finished && "action-step-progress")}
          style={{ animationDuration: `${STEP_MS}ms`, width: finished ? "100%" : undefined }}
        />
      </div>
    </div>
  );
}
