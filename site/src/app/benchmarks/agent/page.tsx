import type { Metadata } from "next";
import Link from "next/link";
import { instrumentSerif } from "@/lib/fonts";
import { Backdrop } from "@/components/backdrop";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  agentResult,
  ci95,
  formatDate,
  fraction,
  int,
  loadAgentBenchmark,
  pct,
  pp,
  publishable,
  ratePct,
  shortCommit,
  tokenDelta,
} from "@/lib/agent-benchmark";

export const metadata: Metadata = {
  title: "Drift agent benchmark",
  description:
    "Does Drift let the same coding agent fix a real dependency upgrade with fewer input tokens and a higher success rate? The paired benchmark, its method, and every per-case result.",
};

const GITHUB = "https://github.com/trydrift/drift";

/**
 * The agent benchmark page.
 *
 * Two questions, kept apart: does the agent consume fewer input tokens with
 * Drift's analysis in hand, and does it fix the upgrade more often? They come
 * from the same trials and are never combined into one score.
 *
 * The method is always shown. The numbers are shown only when the result's
 * own publication gates pass — the benchmark computes those, and this page
 * reads the verdict — so a smoke run or an undersized suite renders the
 * method with an honest "no publishable result yet" and nothing else.
 */
export default function AgentBenchmark() {
  const benchmark = loadAgentBenchmark();
  const result = agentResult(benchmark);
  const published = publishable(benchmark);

  return (
    <div className="relative min-h-screen">
      <Backdrop />

      <header className="relative z-10 mx-auto flex max-w-[1600px] items-center gap-3 px-5 py-5 sm:px-10 lg:px-14">
        <Link href="/" className={`${instrumentSerif.className} text-2xl text-landing`}>
          Drift
        </Link>
        <nav className="ml-auto flex items-center gap-1 sm:gap-2">
          <Link
            href="/benchmarks/"
            className="hidden rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-surface-hover hover:text-foreground sm:block"
          >
            Detection benchmarks
          </Link>
          <a
            href={`${GITHUB}/blob/main/eval/agent/README.md`}
            target="_blank"
            rel="noreferrer"
            className="hidden rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-surface-hover hover:text-foreground sm:block"
          >
            Reproduce
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

      <main className="relative z-10 mx-auto max-w-[1600px] px-5 pb-24 sm:px-10 lg:px-14">
        <section className="pt-8 sm:pt-16">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
            <span className="text-faint">//</span> benchmarks / agent
          </p>
          <h1 className={`${instrumentSerif.className} mt-3 max-w-3xl text-3xl text-landing sm:text-4xl`}>
            Does Drift help a coding agent fix a real dependency upgrade?
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-muted">
            The same agent, model, task, tools and starting repository, run with and without Drift&rsquo;s analysis.
            Each run reports two things from the same session: how many input tokens the agent consumed, and whether
            the upgrade was actually fixed.
          </p>
        </section>

        {published ? (
          <Results result={published} />
        ) : (
          <section className="pt-10">
            <div className="max-w-2xl rounded-xl border border-border bg-surface p-5">
              <h2 className="text-sm font-medium text-foreground">No publishable result yet</h2>
              <p className="mt-2 text-sm leading-6 text-muted">
                {result
                  ? `The latest aggregated run (suite ${result.suite}, ${result.caseCount} case(s), ${result.runsPerCondition} run(s) per condition, ${result.requestedModel}) does not meet the publication gates below, so no figure from it is shown here or anywhere else.`
                  : "No benchmark run has been aggregated yet. The harness, its tests and its method are complete; the numbers wait for a run over a frozen suite that passes every gate."}
              </p>
              {result && (
                <ul className="mt-3 space-y-1 text-sm text-muted">
                  {result.publication.gates
                    .filter((gate) => !gate.passed)
                    .map((gate) => (
                      <li key={gate.name} className="flex gap-2">
                        <span className="font-mono text-xs text-faint">✗</span>
                        <span>
                          <span className="font-mono text-xs text-foreground">{gate.name}</span> — {gate.detail}
                        </span>
                      </li>
                    ))}
                </ul>
              )}
            </div>
          </section>
        )}

        <Methodology result={result} />
      </main>
    </div>
  );
}

function Results({ result }: { result: NonNullable<ReturnType<typeof publishable>> }) {
  const e = result.efficiency;
  const f = result.effectiveness;
  const baseline = result.conditions.find((c) => c.condition === "baseline");
  const drift = result.conditions.find((c) => c.condition === "drift");
  return (
    <>
      <section className="pt-10">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted">Measured on real dependency upgrades</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-border bg-surface p-5">
            <p className="font-mono text-4xl text-landing tabular">{pct(e.medianInputTokenReductionPct)} fewer</p>
            <p className="mt-1 text-sm text-muted">agent input tokens, median across {e.pairedCaseCount} paired cases</p>
            <p className="mt-2 text-xs text-faint">{ci95(e.confidenceInterval95.medianReduction, 100, "%")}</p>
          </div>
          <div className="rounded-xl border border-border bg-surface p-5">
            <p className="font-mono text-4xl text-landing tabular">
              {ratePct(f.baselineSuccessRate)} → {ratePct(f.driftSuccessRate)}
            </p>
            <p className="mt-1 text-sm text-muted">successful dependency remediations ({pp(f.differencePercentagePoints)})</p>
            <p className="mt-2 text-xs text-faint">{ci95(f.confidenceInterval95.differencePercentagePoints, 1, " pp")}</p>
          </div>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
          <Cell label="Without Drift" value={`${int(e.medianBaselineInputTokens)} tokens`} note={`${ratePct(f.baselineSuccessRate)} success`} />
          <Cell label="With Drift" value={`${int(e.medianDriftInputTokens)} tokens`} note={`${ratePct(f.driftSuccessRate)} success`} />
          <Cell label="Cases" value={String(result.caseCount)} note={`${result.runsPerCondition} runs per condition`} />
          <Cell label="Model" value={result.requestedModel} note={`effort ${result.requestedEffort}`} />
        </dl>
        <p className="mt-3 text-sm text-muted">
          Same model. Same task. Same starting repositories. Suite <code className="font-mono text-[12px]">{result.suite}</code>, Drift{" "}
          <code className="font-mono text-[12px]">{shortCommit(result.driftCommit)}</code>, {formatDate(result.generatedAt)}.
        </p>
      </section>

      <section className="pt-12">
        <h2 className={`${instrumentSerif.className} text-2xl text-landing`}>Secondary measurements</h2>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-faint">
              <tr>
                <th className="py-2 pr-4">Metric</th>
                <th className="py-2 pr-4 text-right">Without Drift</th>
                <th className="py-2 text-right">With Drift</th>
              </tr>
            </thead>
            <tbody className="text-muted">
              <Row label="Valid trials" a={String(f.validBaselineTrials)} b={String(f.validDriftTrials)} />
              <Row label="Successful trials" a={fraction(f.successfulBaselineTrials, f.validBaselineTrials)} b={fraction(f.successfulDriftTrials, f.validDriftTrials)} />
              <Row label="Median uncached input tokens" a={int(e.medianBaselineUncachedInputTokens)} b={int(e.medianDriftUncachedInputTokens)} />
              <Row label="Median case-level uncached reduction" a="" b={pct(e.medianUncachedReductionPct)} />
              <Row label="Mean case-level reduction" a="" b={pct(e.meanInputTokenReductionPct)} />
              <Row label="Reduction IQR (case level)" a="" b={e.reductionIqrPct ? `${pct(e.reductionIqrPct.q1)} to ${pct(e.reductionIqrPct.q3)}` : "n/a"} />
              <Row label="Median agent wall-clock change" a="" b={pct(e.medianWallClockChangePct)} />
              <Row label="Median unique files read" a={int(baseline?.medianFilesRead ?? null)} b={int(drift?.medianFilesRead ?? null)} />
              <Row label="Median tool calls" a={int(baseline?.medianToolCalls ?? null)} b={int(drift?.medianToolCalls ?? null)} />
              <Row label="Cases where Drift improved / tied / was worse" a="" b={`${f.caseLevel.improved} / ${f.caseLevel.tied} / ${f.caseLevel.baselineBetter}`} />
            </tbody>
          </table>
        </div>
      </section>

      <section className="pt-12">
        <h2 className={`${instrumentSerif.className} text-2xl text-landing`}>Every case</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">The whole suite, favourable or not. Token Δ is the change in median gross input tokens; a negative number is fewer tokens with Drift.</p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-faint">
              <tr>
                <th className="py-2 pr-4">Case</th>
                <th className="py-2 pr-4 text-right">Baseline success</th>
                <th className="py-2 pr-4 text-right">Drift success</th>
                <th className="py-2 pr-4 text-right">Δ success</th>
                <th className="py-2 text-right">Token Δ</th>
              </tr>
            </thead>
            <tbody className="text-muted">
              {result.cases.map((c) => (
                <tr key={c.caseId} className="border-t border-border">
                  <td className="py-2 pr-4 font-mono text-xs text-foreground">{c.caseId}</td>
                  <td className="py-2 pr-4 text-right tabular">{fraction(c.baselineSuccesses, c.validBaselineTrials)} ({ratePct(c.baselineSuccessRate, 0)})</td>
                  <td className="py-2 pr-4 text-right tabular">{fraction(c.driftSuccesses, c.validDriftTrials)} ({ratePct(c.driftSuccessRate, 0)})</td>
                  <td className="py-2 pr-4 text-right tabular">{pp(c.successDifferencePp)}</td>
                  <td className="py-2 text-right tabular">{tokenDelta(c.inputTokenReduction)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="pt-12">
        <h2 className={`${instrumentSerif.className} text-2xl text-landing`}>Why trials failed</h2>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-faint">
              <tr>
                <th className="py-2 pr-4">Reason</th>
                <th className="py-2 pr-4 text-right">Without Drift</th>
                <th className="py-2 text-right">With Drift</th>
              </tr>
            </thead>
            <tbody className="text-muted">
              {[...new Set([...Object.keys(baseline?.failureReasons ?? {}), ...Object.keys(drift?.failureReasons ?? {})])].sort().map((reason) => (
                <Row key={reason} label={reason} a={String(baseline?.failureReasons[reason] ?? 0)} b={String(drift?.failureReasons[reason] ?? 0)} />
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-sm text-muted">
          {result.exclusions.length} trial(s) were excluded as infrastructure failures (provider outage, a check that could not start) and count for neither condition.
        </p>
      </section>
    </>
  );
}

function Methodology({ result }: { result: ReturnType<typeof agentResult> }) {
  const eco = result ? Object.entries(result.ecosystems).map(([k, v]) => `${k} ×${v}`).join(", ") : null;
  return (
    <section className="pt-12">
      <h2 className={`${instrumentSerif.className} text-2xl text-landing`}>How the numbers are produced</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
        Written for the reader who has seen a tool quote a percentage before. Every item below is enforced by the harness in{" "}
        <a href={`${GITHUB}/tree/main/eval/src/agent`} target="_blank" rel="noreferrer" className="text-brand-text underline decoration-dotted underline-offset-2">
          eval/src/agent
        </a>
        , and every trial artifact records the values it lists.
      </p>

      <div className="mt-5 space-y-3">
        <Item n="01" title="Goal">
          Measure whether Drift lets the same coding agent solve a real dependency migration with less model input and a higher
          probability of a behaviourally correct fix. Not whether Drift&rsquo;s prompt is shorter, and not whether its answer reads well.
        </Item>
        <Item n="02" title="Provenance">
          {result ? (
            <>
              Suite <code className="font-mono text-[12px]">{result.suite}</code> ({result.suiteStatus}), generated {formatDate(result.generatedAt)}, Drift{" "}
              <code className="font-mono text-[12px]">{shortCommit(result.driftCommit)}</code> (v{result.driftVersion}), agent {result.provider}{" "}
              {result.agentCliVersion}, requested model <code className="font-mono text-[12px]">{result.requestedModel}</code> at effort {result.requestedEffort}; models the
              sessions confirmed: {Object.entries(result.confirmedModels).map(([m, n]) => `${m} (${n} trials)`).join(", ")}. {result.caseCount} case(s), {result.runsPerCondition} run(s) per
              condition. Ecosystems: {eco}. Case roles: {Object.entries(result.caseRoles).map(([k, v]) => `${k} ×${v}`).join(", ")}.
            </>
          ) : (
            "Recorded on every result: suite version, date, Drift commit and version, agent CLI version, requested and confirmed model, effort, case count and runs per condition."
          )}
        </Item>
        <Item n="03" title="Starting state">
          A real repository at a fixed commit, with the dependency already upgraded in its manifest and lockfile and the application code
          not yet migrated. Each trial materializes a fresh git repository with exactly two commits — before and after the bump — no
          remote, and no later history, so the maintainer&rsquo;s eventual fix is not reachable.
        </Item>
        <Item n="04" title="Baseline condition">
          The agent receives the task text — the dependency, the two versions, an instruction to fix every incompatibility without
          reverting, run the appropriate checks, and leave the repository working — with its normal tools: file reads, search, shell,
          the package manager, the installed package contents. Nothing is withheld and nothing is pre-loaded.
        </Item>
        <Item n="05" title="Drift condition">
          The identical task text, followed by Drift&rsquo;s own report for that upgrade — the same text{" "}
          <code className="font-mono text-[12px]">drift analyze --markdown{result?.configuration.driftVerify ? " --verify" : ""}</code> prints and the
          GitHub Action posts: computed breaking changes with evidence, the file and line of every place they reach, the project&rsquo;s own
          checks run against the bumped tree. One benchmark-authored sentence introduces it. Same model, effort, tools, permissions,
          network policy, time limit and budget as the baseline.
        </Item>
        <Item n="06" title="Input tokens">
          {result ? result.methodology.inputTokenDefinition : "Gross agent input tokens, read from the agent CLI's own cumulative per-model usage record: input + cache-read + cache-creation tokens over every model turn in the session. Uncached input tokens are a secondary metric."}
        </Item>
        <Item n="07" title="Success">
          {result ? result.methodology.successDefinition : "Binary per trial: the dependency is still at the upgraded version after a fresh install, the project's own checks pass, the hidden regression tests pass, and no case-specific prohibited-workaround rule fires. A timed-out or errored session fails."}
        </Item>
        <Item n="08" title="Hidden tests">
          Each case carries regression tests that exercise the behaviour the upgrade actually broke. They live outside the workspace
          and are copied in only after the agent process has exited. A case is admitted only if those tests fail at the start state and
          pass with a known-correct fix, and the known-correct state is validated twice for determinism.
        </Item>
        <Item n="09" title="Case admission">
          Real incompatibility; start state reproduces the failure; hidden tests fail before and pass after the reference fix; the
          dependency remains upgraded in the fixed state; validation is deterministic; the workspace audits clean of hidden material;
          the task is a legitimate migration. Admitted cases are frozen into a versioned suite by content hash.
        </Item>
        <Item n="10" title="Aggregation">
          Efficiency: per case, the median gross input tokens of valid baseline trials against the median of valid Drift trials; the
          headline is the median of those case-level reductions, never a ratio of totals. Effectiveness: successful valid trials over valid
          trials per condition, reported as a percentage-point difference, with the case-level view beside it.
        </Item>
        <Item n="11" title="Uncertainty">
          {result ? result.methodology.bootstrap : "A two-level percentile bootstrap: cases resampled with replacement, then each condition's trials within each drawn case, with a fixed seed."}
          {" "}Intervals are reported for the median reduction and the success-rate difference. No trial is rerun because of its result.
        </Item>
        <Item n="12" title="Infrastructure failures">
          A provider outage, an agent that could not launch, or a validation command that could not start excludes the trial with the reason
          recorded, for either condition. An agent that timed out, errored, or produced a wrong fix is an ordinary failure and is never excluded.
        </Item>
        <Item n="13" title="Isolation">
          {result ? result.methodology.isolation : "A fresh temporary repository per trial, audited to contain no hidden material; hidden tests and the reference patch are copied in only after the agent exits. A workspace audit, not an OS sandbox."}
        </Item>
        <Item n="14" title="Tool counting">
          {result ? result.methodology.toolCounting : "Tool calls are counted from the session's event stream; a shell command is one call however many files it read."}
        </Item>
        <Item n="15" title="Limitations">
          Agents are stochastic and results depend on the model, agent version and effort recorded; provider caching shapes the gross
          token figure; wall clock includes network latency; the suite is dependency migrations only; the share of held-out cases is
          recorded per result and an early suite has few; passing tests cannot prove the absence of every regression; hidden-test quality
          varies by case and each case&rsquo;s tests are in the repository for review.
        </Item>
        <Item n="16" title="Reproduce">
          <code className="font-mono text-[12px]">npm run benchmark:agent:validate</code>, then{" "}
          <code className="font-mono text-[12px]">npm run benchmark:agent -- --suite &lt;suite&gt; --runs 5</code>, then{" "}
          <code className="font-mono text-[12px]">npm run benchmark:agent:aggregate -- --runs &lt;run-id&gt;</code>,{" "}
          <code className="font-mono text-[12px]">npm run benchmark:agent:report</code> and{" "}
          <code className="font-mono text-[12px]">npm run benchmark:agent:verify</code>. Raw per-trial artifacts, including the final diff and
          every validation output, are under{" "}
          <a href={`${GITHUB}/tree/main/eval/results/agent`} target="_blank" rel="noreferrer" className="text-brand-text underline decoration-dotted underline-offset-2">
            eval/results/agent
          </a>
          ; the full method is in{" "}
          <a href={`${GITHUB}/blob/main/eval/agent/README.md`} target="_blank" rel="noreferrer" className="text-brand-text underline decoration-dotted underline-offset-2">
            eval/agent/README.md
          </a>
          .
        </Item>
      </div>
    </section>
  );
}

function Item({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-xs text-brand-text">{n}</span>
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
      </div>
      <p className="mt-2 text-sm leading-6 text-muted">{children}</p>
    </div>
  );
}

function Cell({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="bg-surface px-4 py-3">
      <dt className="text-[11px] uppercase tracking-wider text-faint">{label}</dt>
      <dd className="mt-1 font-mono text-base text-foreground tabular">{value}</dd>
      {note && <dd className="text-xs text-muted">{note}</dd>}
    </div>
  );
}

function Row({ label, a, b }: { label: string; a: string; b: string }) {
  return (
    <tr className="border-t border-border">
      <td className="py-2 pr-4">{label}</td>
      <td className="py-2 pr-4 text-right tabular">{a}</td>
      <td className="py-2 text-right tabular">{b}</td>
    </tr>
  );
}
