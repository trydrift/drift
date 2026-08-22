"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { GhIcon } from "@/components/gh";

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
 * Drawn as the workflow-run page it would be. A developer who has watched a
 * run go green knows this layout — the run header, the step list with its
 * status glyphs, the log that scrolls under the open step — and recognising it
 * costs nothing where reading a fifth kind of card costs attention. The steps
 * are the real ones, in the real order, with the real permissions from
 * `examples/workflows/drift.yml`.
 */

interface Step {
  /** What GitHub is doing, in its own vocabulary. */
  title: string;
  detail: string;
  /** The log the step writes, in its own voice. */
  log: string[];
  /** Wall-clock, as a run page shows it. */
  took: string;
}

const STEPS: Step[] = [
  {
    title: "Set Up Job",
    detail: "Triggers only on manifest and lockfile changes, not every push.",
    log: [
      "on: push",
      "paths: **/package.json, **/go.mod, **/vcpkg.json, …",
      "permissions: contents: write · issues: write · pull-requests: write · checks: write",
    ],
    took: "2s",
  },
  {
    title: "Run trydrift/drift@v0",
    detail:
      "The same pipeline the CLI runs — evidence, breaking changes, and the lines in this repository that use them.",
    log: [
      "detect  ▸ 2 manifests, 1 lockfile",
      "evidence ▸ registry + release notes + computed surface",
      "localize ▸ 25 sites across 10 files",
    ],
    took: "48s",
  },
  {
    title: "Post the Check Run",
    detail:
      "Affected, upstream-only, or clean, with a file count — posted as a check, right where reviewers already look.",
    log: ["drift / analyze — affected", "3 files · 13 upstream changes · 0 gaps"],
    took: "1s",
  },
  {
    title: "Ask Before Acting",
    detail:
      "A fresh install files an approval issue containing the plan and waits for a human to comment /drift apply. Autonomy is opt-in, per repository.",
    log: ["mode: approve", "opened issue #482 — “Upgrade plan: w3lib 1.17.0 → 2.4.1”", "waiting for /drift apply"],
    took: "1s",
  },
  {
    title: "Verify the Approval",
    detail:
      "A human comments /drift apply. Drift re-verifies before acting on it — every check fails closed.",
    log: [
      "commenter: write permission ✓",
      "plan digest: matches issue #482 ✓",
      "base commit: unchanged since analysis ✓",
    ],
    took: "1s",
  },
  {
    title: "Open the Pull Request",
    detail:
      "One commit per concern, in dependency order, each resolved by a deterministic codemod, then a validated fix plan, then an agent — never silently, and always in that order.",
    log: ["3 commits · codemod → fix plan → agent", "every claim cites the evidence it came from"],
    took: "12s",
  },
];

const STEP_MS = 2600;

/**
 * The homepage's default-visible version of this section: the three-word
 * shape of the flow and the trust boundary, not the six-step animated run.
 * The full `ActionFlow` below is still real and still here — just behind a
 * `<details>` for whoever wants to watch it.
 */
const TRUST_SIGNALS = [
  "Approval by default",
  "Never merges",
  "Guardrails fail closed",
  "Unverified ≠ safe",
] as const;

export function ActionSummary() {
  return (
    <div>
      <p className="flex flex-wrap items-center gap-2 font-mono text-sm text-foreground">
        <span className="rounded-lg border border-border bg-surface px-2.5 py-1">Analyze</span>
        <span className="text-faint" aria-hidden>→</span>
        <span className="rounded-lg border border-border bg-surface px-2.5 py-1">Ask</span>
        <span className="text-faint" aria-hidden>→</span>
        <span className="rounded-lg border border-border bg-surface px-2.5 py-1">PR</span>
      </p>
      <div className="mt-4 flex flex-wrap gap-1.5">
        {TRUST_SIGNALS.map((signal) => (
          <span
            key={signal}
            className="rounded-full border border-brand/25 bg-brand-soft px-2.5 py-1 text-[12px] font-medium text-brand-text"
          >
            {signal}
          </span>
        ))}
      </div>
    </div>
  );
}

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
    <div className="overflow-hidden rounded-2xl border border-border bg-surface">
      {/* The run header. */}
      <div className="border-b border-border bg-surface-hover/40 px-4 py-3">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "flex size-5 shrink-0 items-center justify-center rounded-full",
              finished ? "bg-brand text-brand-foreground" : "border border-brand/50 bg-brand-soft text-brand-text orb",
            )}
          >
            <GhIcon icon={finished ? "check" : "play"} className="size-3.5" />
          </span>
          <span className="truncate text-[13px] font-semibold text-foreground">
            Analyze Dependency Changes
          </span>
          {finished && playing ? (
            <button
              type="button"
              onClick={() => setActive(0)}
              className="ml-auto shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[11px] text-faint transition-colors hover:bg-surface-hover hover:text-foreground"
            >
              re-run
            </button>
          ) : (
            <span className="ml-auto shrink-0 font-mono text-[11px] text-faint">
              {String(active + 1).padStart(2, "0")} / {String(STEPS.length).padStart(2, "0")}
            </span>
          )}
        </div>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10.5px] text-faint">
          <span className="rounded-full border border-border bg-surface px-1.5 py-0.5">main</span>
          <span>.github/workflows/drift.yml</span>
          <span className="text-border">·</span>
          <span>push · pyproject.toml</span>
        </p>
      </div>

      <ol className="divide-y divide-border">
        {STEPS.map((step, index) => {
          const done = index < active;
          const current = index === active;

          return (
            <li key={step.title} className={cn("transition-colors duration-500", current && "bg-brand-soft/25")}>
              <div className="flex items-center gap-2.5 px-4 py-2.5">
                <StepGlyph state={done ? "done" : current ? "running" : "queued"} />
                <p
                  className={cn(
                    "min-w-0 flex-1 truncate text-[12.5px] font-medium transition-colors duration-500",
                    current || done ? "text-foreground" : "text-muted",
                  )}
                >
                  {step.title}
                </p>
                <span className="shrink-0 font-mono text-[10.5px] text-faint">
                  {done || current ? step.took : "—"}
                </span>
              </div>

              {/* The open step, showing its log. Only one is ever open, which
                  is how a run page behaves and also keeps the panel a fixed
                  enough height not to shove the page around. */}
              {current && (
                <div className="px-4 pb-3">
                  <p className="mb-2 text-[12px] leading-relaxed text-muted">{step.detail}</p>
                  <div className="overflow-x-auto rounded-lg border border-border bg-(--pre-bg) py-1.5">
                    {step.log.map((line, n) => (
                      <p key={line} className="flex gap-3 px-2 font-mono text-[11px] leading-[1.7]">
                        <span className="w-4 shrink-0 select-none text-right text-faint/70 tabular">
                          {n + 1}
                        </span>
                        <span className="whitespace-pre text-muted">{line}</span>
                      </p>
                    ))}
                  </div>
                </div>
              )}
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

function StepGlyph({ state }: { state: "done" | "running" | "queued" }) {
  if (state === "done") {
    return (
      <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-brand text-brand-foreground">
        <svg viewBox="0 0 16 16" className="size-2.5" aria-hidden>
          <path
            d="m4 8 3 3 5-6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }

  if (state === "running") {
    return (
      <span
        className="orb size-4 shrink-0 rounded-full border-2 border-brand/40 border-t-brand"
        aria-hidden
      />
    );
  }

  return <span className="size-4 shrink-0 rounded-full border border-dashed border-border" aria-hidden />;
}
