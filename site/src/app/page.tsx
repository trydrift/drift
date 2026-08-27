import Link from "next/link";
import { instrumentSerif } from "@/lib/fonts";
import { Backdrop } from "@/components/backdrop";
import { CopyCommand } from "@/components/copy-command";
import { Demo } from "@/components/demo";
import { EcosystemsSummary } from "@/components/ecosystems";
import { Pipeline } from "@/components/pipeline";
import { ActionSummary, ActionFlow } from "@/components/action-flow";
import { ThemeToggle } from "@/components/theme-toggle";
import { loadRecordings } from "@/lib/load";
import { totalsOf, type Recording } from "@/lib/recordings";
import { loadBenchmarks } from "@/lib/benchmarks";
import { buildNarrative } from "@/lib/benchmark-narrative";
import {
  MAVEN_BREAKING_CHANGE_STUDY,
  OUTDATED_SOFTWARE_COST_STUDY,
  VULNERABLE_DEPENDENCIES_STUDY,
} from "@/lib/external-citations";

/**
 * The landing page.
 *
 * One argument, made in about five sections instead of a long scroll: what
 * Drift does, why dependency updates are risky enough to need it, why an
 * update bot doesn't already solve this, what evidence Drift produces, and
 * how to try it. Every section prefers a number, a distribution, a flow, or a
 * real artifact over a paragraph — the detail nobody reads on a landing page
 * still exists, it's one click away in a `<details>` or a linked page instead
 * of default-visible prose.
 */

const GITHUB = "https://github.com/trydrift/Drift";
const FEATURE_BOARD = "/features/";
const MARKETPLACE = "https://marketplace.visualstudio.com/items?itemName=drift.drift";

export default function Home() {
  const recordings = loadRecordings();
  const languages = [...new Set(recordings.map((r) => r.language))];
  const proof = summarizeRecordings(recordings);
  const narrative = buildNarrative(loadBenchmarks());
  const unaffectedShare = 100 - MAVEN_BREAKING_CHANGE_STUDY.clientBreakRateValue;

  return (
    <div className="relative min-h-screen">
      <Backdrop />

      <header className="relative z-10 mx-auto flex max-w-5xl items-center gap-3 px-5 py-5 sm:px-8">
        <span className={`${instrumentSerif.className} text-2xl text-landing`}>Drift</span>
        <nav className="ml-auto flex items-center gap-1 sm:gap-2">
          <a
            href="#how"
            className="rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            How It Works
          </a>
          <Link href={FEATURE_BOARD} className="rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-surface-hover hover:text-foreground">Features</Link>
          <Link
            href="/support/"
            className="hidden rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-surface-hover hover:text-foreground sm:block"
          >
            Ecosystems
          </Link>
          <Link
            href="/benchmarks/"
            className="hidden rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-surface-hover hover:text-foreground sm:block"
          >
            Benchmarks
          </Link>
          <a
            href="#action"
            className="hidden rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-surface-hover hover:text-foreground sm:block"
          >
            Action
          </a>
          <Link
            href="/configure/"
            className="hidden rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-surface-hover hover:text-foreground sm:block"
          >
            Configure
          </Link>
          <a
            href="mailto:trydrift@outlook.com"
            className="hidden rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-surface-hover hover:text-foreground sm:block"
          >
            Talk to us
          </a>
          <a
            href={GITHUB}
            target="_blank"
            rel="noreferrer"
            className="rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            GitHub
          </a>
          <ThemeToggle />
        </nav>
      </header>

      <main className="relative z-10 mx-auto max-w-5xl px-5 pb-24 sm:px-8">
        {/* ── Hero ────────────────────────────────────────────────────── */}
        <section className="pt-8 sm:pt-16">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
            <span className="text-faint">//</span> evidence, not guesswork
          </p>
          <h1
            className={`${instrumentSerif.className} mt-4 max-w-3xl text-4xl leading-[1.05] text-landing sm:text-5xl md:text-6xl`}
          >
            Your dependency bot finds updates.
            <br />
            Drift finds the ones that break your code.
          </h1>
          <p className="mt-5 max-w-2xl text-[15px] leading-relaxed text-muted sm:text-base">
            API diffs → exact call sites → reviewable fixes. Every finding linked to evidence.
          </p>

          {/* Compact entry points, not a paragraph per surface — VS Code and
              the demo are the two actions, side by side; everything else
              (benchmarks, the Action, the repo) is a link, not a button. */}
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <a
              href={MARKETPLACE}
              target="_blank"
              rel="noreferrer"
              className="rounded-full bg-brand px-5 py-2.5 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200"
            >
              Install for VS Code
            </a>
            <a
              href="#demo"
              className="rounded-full border border-border bg-surface px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover"
            >
              Watch a Real Analysis
            </a>
          </div>

          <p className="mt-3">
            <Link
              href="/benchmarks/"
              className="text-sm font-medium text-brand-text underline decoration-dotted underline-offset-2"
            >
              See the benchmarks
            </Link>
          </p>
          <p className="mt-3"><Link href={FEATURE_BOARD} className="inline-flex rounded-full border border-brand/40 bg-brand-soft px-3 py-1.5 text-sm font-medium text-brand-text">Vote on what Drift builds next →</Link></p>

          <p className="mt-4 font-mono text-xs text-muted">
            <CopyCommand text="npm install -g @usedrift/cli">
              <span className="text-faint">$</span> npm install -g @usedrift/cli
            </CopyCommand>
          </p>

          <p className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs text-faint">
            <span>{languages.join(" · ")}</span>
            <a
              href={GITHUB}
              target="_blank"
              rel="noreferrer"
              className="text-brand-text underline decoration-dotted underline-offset-2"
            >
              View on GitHub
            </a>
            <a href="#action" className="text-brand-text underline decoration-dotted underline-offset-2">
              GitHub Action
            </a>
          </p>
        </section>

        {/* ── Problem scale ───────────────────────────────────────────── */}
        {/*
          Why an update bot's "it's semver-compliant" isn't the same claim as
          "it's safe" — four sourced figures, no introductory paragraph. The
          Maven study is the primary source (large, peer-reviewed, and about
          breaking updates specifically); the cost and vulnerability figures
          are named, US-wide/industry studies, not Drift's own claims — every
          card labels its scope inline and in the tooltip. Drift's own
          measured accuracy lives in its own section later, not mixed in with
          these.
        */}
        <section className="pt-14 sm:pt-20">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
            <span className="text-faint">//</span> problem scale
          </p>

          <div className="mt-5 grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              value={MAVEN_BREAKING_CHANGE_STUDY.clientBreakRate}
              description="of dependency updates broke client code"
              sourceLine="142,355-dependency Maven study · Empirical Software Engineering"
              title={`${MAVEN_BREAKING_CHANGE_STUDY.title} ${MAVEN_BREAKING_CHANGE_STUDY.scope}`}
              url={MAVEN_BREAKING_CHANGE_STUDY.url}
            />
            <StatCard
              value={MAVEN_BREAKING_CHANGE_STUDY.nonMajorShare}
              description="of those breaking changes occurred on non-major updates"
              sourceLine="same peer-reviewed study"
              title={`${MAVEN_BREAKING_CHANGE_STUDY.title} ${MAVEN_BREAKING_CHANGE_STUDY.scope}`}
              url={MAVEN_BREAKING_CHANGE_STUDY.url}
            />
            <StatCard
              value={OUTDATED_SOFTWARE_COST_STUDY.value}
              description={OUTDATED_SOFTWARE_COST_STUDY.description}
              sourceLine={OUTDATED_SOFTWARE_COST_STUDY.sourceLine}
              title={`${OUTDATED_SOFTWARE_COST_STUDY.title} ${OUTDATED_SOFTWARE_COST_STUDY.scope}`}
              url={OUTDATED_SOFTWARE_COST_STUDY.url}
            />
            <StatCard
              value={VULNERABLE_DEPENDENCIES_STUDY.value}
              description={VULNERABLE_DEPENDENCIES_STUDY.description}
              sourceLine={VULNERABLE_DEPENDENCIES_STUDY.sourceLine}
              title={`${VULNERABLE_DEPENDENCIES_STUDY.title} ${VULNERABLE_DEPENDENCIES_STUDY.scope}`}
              url={VULNERABLE_DEPENDENCIES_STUDY.url}
            />
          </div>

          {/* The same 11.58% as a shape instead of a sentence. */}
          <div className="mt-5">
            <div className="flex h-3 overflow-hidden rounded-full bg-surface-hover" aria-hidden>
              <span className="bg-brand/40" style={{ width: `${unaffectedShare}%` }} />
              <span className="bg-rose-600" style={{ width: `${MAVEN_BREAKING_CHANGE_STUDY.clientBreakRateValue}%` }} />
            </div>
            <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-brand/40" aria-hidden />
                {unaffectedShare.toFixed(2)} of every 100 updates, unaffected
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-rose-600" aria-hidden />
                {MAVEN_BREAKING_CHANGE_STUDY.clientBreakRateValue} broke a client, per the same study
              </span>
            </p>
          </div>
        </section>

        {/* ── The demo, the outcome distribution, and the benchmark proof ─ */}
        {/*
          One proof section instead of three: a real recorded run, the one
          distribution that matters (Safe Here / Affects You / Not Verified),
          and Drift's own measured benchmark result with a link to the full
          methodology. No prose explaining why a browser can't run a package
          manager — a one-line label says what the panels are.
        */}
        <section id="demo" className="scroll-mt-8 pt-16 sm:pt-24">
          <h2 className={`${instrumentSerif.className} text-2xl text-landing sm:text-3xl`}>
            See Drift analyze a real repository
          </h2>
          <p className="mt-2 font-mono text-[11px] text-faint">Recorded from a real Drift run · linked commit</p>

          <div className="mt-6">
            <Demo recordings={recordings} />
          </div>

          <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_1fr] lg:items-start">
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                Totals across every recording above
              </h3>
              <VerdictStack proof={proof} />
            </div>

            <div>
              <h3 className="text-sm font-semibold text-foreground">Measured on public benchmarks</h3>
              <Link
                href="/benchmarks/"
                className="group mt-3 block overflow-hidden rounded-lg border border-border bg-surface/75 px-5 py-4 transition-colors hover:bg-surface-hover"
              >
                <p className="font-mono text-3xl text-landing tabular">{narrative.roseau.recallPercent}</p>
                <p className="mt-1.5 max-w-xl text-[13px] leading-snug text-muted">
                  recall on {narrative.roseau.available} hand-labelled real Java API changes (
                  {narrative.roseau.precisionPercent} precision).
                </p>
                <p className="mt-2.5 text-[11px] uppercase tracking-[0.14em] text-faint group-hover:text-brand-text">
                  Public benchmark → methodology + every miss →
                </p>
              </Link>
            </div>
          </div>
        </section>

        <Pipeline />

        {/* ── Coverage + trust ────────────────────────────────────────── */}
        <section id="ecosystems" className="scroll-mt-8 pt-14 sm:pt-20">
          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <h3 className="text-sm font-semibold text-foreground">Ecosystem coverage</h3>
              <div className="mt-3">
                <EcosystemsSummary href="/support/" />
              </div>
            </div>

            <div id="action" className="scroll-mt-8">
              <h3 className="text-sm font-semibold text-foreground">On every dependency change</h3>
              <div className="mt-3">
                <ActionSummary />
              </div>
              <details className="group mt-4">
                <summary className="cursor-pointer list-none text-[12.5px] text-brand-text underline decoration-dotted underline-offset-2 [&::-webkit-details-marker]:hidden">
                  See the full run
                </summary>
                <div className="mt-4">
                  <ActionFlow />
                </div>
              </details>
            </div>
          </div>
        </section>

        {/* ── Vision ──────────────────────────────────────────────────── */}
        {/*
          Enterprise direction, not a speculative features list. Every card
          is labelled by what it is — Vision — so nothing here reads as a
          capability Drift has today. The progression line underneath is the
          whole argument: public dependencies, then private ones, then the
          organization's dependency graph as a whole.
        */}
        <section className="pt-16 sm:pt-24">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className={`${instrumentSerif.className} text-2xl text-landing sm:text-3xl`}>
              Where Drift is going
            </h2>
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-faint">Vision</p>
          </div>
          <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-faint">
            <span>Public dependencies today</span>
            <span aria-hidden>→</span>
            <span>Private dependencies</span>
            <span aria-hidden>→</span>
            <span>Organization-wide dependency graph</span>
          </p>

          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <VisionCard
              title="Generate the migration, not just detect it"
              detail="Derive migration guidance and changelog-quality upgrade instructions from API diffs, release artifacts, and tests when maintainers don't provide adequate docs."
            />
            <VisionCard
              title="Understand private APIs too"
              detail="Extend evidence and compatibility analysis to internal packages, private registries, and org-owned APIs — code that never appears in a public registry."
            />
            <VisionCard
              title="Reason across repositories"
              detail="Build org-level dependency context. When a shared API changes, find every affected repository and produce a migration plan for each."
            />
          </div>
        </section>

        {/* ── Final CTA ───────────────────────────────────────────────── */}
        <section className="mt-16 rounded-2xl border border-border bg-surface/60 px-6 py-8 sm:mt-24 sm:px-10 sm:py-10">
          <h2 className={`${instrumentSerif.className} text-2xl text-landing sm:text-3xl`}>
            Find which dependency updates actually need work.
          </h2>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <a
              href={MARKETPLACE}
              target="_blank"
              rel="noreferrer"
              className="rounded-full bg-brand px-5 py-2.5 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200"
            >
              Install for VS Code
            </a>
            <a
              href={`${GITHUB}#try-it-with-zero-permissions`}
              target="_blank"
              rel="noreferrer"
              className="rounded-full border border-border bg-surface px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover"
            >
              GitHub Action
            </a>
            <Link href={FEATURE_BOARD} className="rounded-full border border-border bg-surface px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover">Feature requests</Link>
          </div>
          <p className="mt-4 font-mono text-xs text-muted">
            <CopyCommand text="npm install -g @usedrift/cli">
              <span className="text-faint">$</span> npm install -g @usedrift/cli
            </CopyCommand>
          </p>
        </section>
      </main>

      <footer className="relative z-10 border-t border-border bg-background/60">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-5 py-6 text-xs text-faint sm:px-8">
          <span className={`${instrumentSerif.className} text-base text-landing`}>Drift</span>
          <a href={GITHUB} target="_blank" rel="noreferrer" className="transition-colors hover:text-foreground">
            GitHub
          </a>
          <a href="mailto:trydrift@outlook.com" className="transition-colors hover:text-foreground">
            Talk to us
          </a>
          <Link href={FEATURE_BOARD} className="transition-colors hover:text-foreground">Feature requests</Link>
          <span className="ml-auto">
            Every sample on this page is a real run against the linked commit.
          </span>
        </div>
      </footer>
    </div>
  );
}

interface ProofSummary {
  recordings: number;
  /**
   * Unique package ecosystems, not unique language names. Swift covers two
   * package ecosystems and C++ covers several, so counting languages and
   * labelling the result "ecosystems" made the strip contradict the heading
   * directly above it.
   */
  ecosystems: number;
  packages: number;
  affected: number;
  clean: number;
  unchecked: number;
  breaking: number;
  sites: number;
}

function summarizeRecordings(recordings: Recording[]): ProofSummary {
  return recordings.reduce<ProofSummary>(
    (summary, recording) => {
      const totals = totalsOf(recording);
      summary.packages += totals.packages;
      summary.affected += totals.affected;
      summary.clean += totals.clean;
      summary.unchecked += totals.unchecked;
      summary.breaking += totals.breaking;
      summary.sites += totals.sites;
      return summary;
    },
    {
      recordings: recordings.length,
      ecosystems: new Set(recordings.map((recording) => recording.ecosystem)).size,
      packages: 0,
      affected: 0,
      clean: 0,
      unchecked: 0,
      breaking: 0,
      sites: 0,
    },
  );
}

/**
 * One externally sourced number, linked straight to where it came from. Used
 * for the problem-scale figures — market/case-study evidence, kept out of the
 * section that carries Drift's own measured benchmark result so the two
 * different kinds of claim (someone else's study vs. Drift's own run) don't
 * read as one undifferentiated wall of numbers.
 */
function StatCard({
  value,
  description,
  sourceLine,
  title,
  url,
}: {
  value: string;
  description: string;
  sourceLine: string;
  title: string;
  url: string;
}) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="group bg-surface/75 px-5 py-4 transition-colors hover:bg-surface-hover"
      title={title}
    >
      <p className="font-mono text-3xl text-landing tabular">{value}</p>
      <p className="mt-1.5 text-[13px] leading-snug text-muted">{description}</p>
      <p className="mt-2.5 text-[11px] uppercase tracking-[0.14em] text-faint group-hover:text-brand-text">
        {sourceLine} ↗
      </p>
    </a>
  );
}

function VerdictStack({ proof }: { proof: ProofSummary }) {
  const total = Math.max(1, proof.clean + proof.affected + proof.unchecked);
  const lanes = [
    { label: "Safe Here", value: proof.clean, className: "bg-brand" },
    { label: "Affects You", value: proof.affected, className: "bg-rose-600" },
    { label: "Not Verified", value: proof.unchecked, className: "bg-amber-500" },
  ];

  return (
    <div className="mt-4">
      <div className="flex h-3 overflow-hidden rounded-full bg-surface-hover">
        {lanes.map((lane) => (
          <span
            key={lane.label}
            className={lane.className}
            style={{ width: lane.value === 0 ? 0 : `${Math.max(4, (lane.value / total) * 100)}%` }}
            aria-hidden
          />
        ))}
      </div>
      <div className="mt-4 grid gap-2">
        {lanes.map((lane) => (
          <div key={lane.label} className="flex items-center gap-3 text-sm">
            <span className={`size-2.5 rounded-full ${lane.className}`} aria-hidden />
            <span className="min-w-0 flex-1 text-muted">{lane.label}</span>
            <span className="font-mono text-xs text-foreground tabular">{lane.value}</span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[12px] leading-relaxed text-faint">
        {proof.sites} exact call sites, linked to files and lines. Missing evidence is shown as a
        gap, not softened into a pass.
      </p>
    </div>
  );
}

function VisionCard({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface/70 p-4">
      <h3 className="text-[13px] font-semibold text-foreground">{title}</h3>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">{detail}</p>
    </div>
  );
}
