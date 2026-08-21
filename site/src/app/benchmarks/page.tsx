import type { Metadata } from "next";
import Link from "next/link";
import { instrumentSerif } from "@/lib/fonts";
import { Backdrop } from "@/components/backdrop";
import { ThemeToggle } from "@/components/theme-toggle";
import { BenchmarkCard } from "@/components/benchmark-card";
import { byClass, classLabel, formatDate, loadBenchmarks } from "@/lib/benchmarks";
import { buildNarrative } from "@/lib/benchmark-narrative";

export const metadata: Metadata = {
  title: "Drift benchmarks",
  description:
    "What Drift scores on five public breaking-change datasets, what each number is over, and what none of them establish.",
};

const GITHUB = "https://github.com/trydrift/Drift";

/**
 * The benchmark page.
 *
 * Written for one reader: an engineer who has seen a tool claim a percentage
 * before, does not believe this one either, and will decide in about ninety
 * seconds whether the methodology is worth their time. Everything here follows
 * from that.
 *
 * There is no headline accuracy figure, because there is no honest one. The
 * corpora answer two different questions over different ground truth, and one
 * of them cannot support a precision at all. A single "Drift is N% accurate"
 * would be an average over incomparable things, which is the number this page
 * exists not to print.
 *
 * Every figure is a fraction before it is a percentage, every exclusion is
 * counted with its reason, and the metrics that were *not* computed are listed
 * with why. A reader who only reads the refusals should come away better
 * informed than one who only reads the results.
 */
export default function Benchmarks() {
  const benchmarks = loadBenchmarks();
  const { datasets, generatedAt } = benchmarks;
  const groups = byClass(datasets);
  const narrative = buildNarrative(benchmarks);

  return (
    <div className="relative min-h-screen">
      <Backdrop />

      <header className="relative z-10 mx-auto flex max-w-5xl items-center gap-3 px-5 py-5 sm:px-8">
        <Link href="/" className={`${instrumentSerif.className} text-2xl text-landing`}>
          Drift
        </Link>
        <nav className="ml-auto flex items-center gap-1 sm:gap-2">
          <Link
            href="/#how"
            className="hidden rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-surface-hover hover:text-foreground sm:block"
          >
            How It Works
          </Link>
          <a
            href={`${GITHUB}/blob/main/eval/README.md`}
            target="_blank"
            rel="noreferrer"
            className="hidden rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-surface-hover hover:text-foreground sm:block"
          >
            Methodology
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
        <section className="pt-8 sm:pt-16">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
            <span className="text-faint">//</span> benchmarks
          </p>
          <h1 className={`${instrumentSerif.className} mt-3 max-w-3xl text-3xl text-landing sm:text-4xl`}>
            What Drift scores on other people&rsquo;s datasets
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted">
            Five public breaking-change corpora, run against the same Drift the CLI ships. Every number below is read
            out of an artifact a run produced — none is typed into this page — and every one is a fraction before it is
            a percentage.
          </p>

          <div className="mt-6 max-w-2xl rounded-xl border border-border bg-surface p-5">
            <h2 className="text-sm font-medium text-foreground">There is no single accuracy number here</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              These corpora answer two different questions — <em>did Drift read the upstream change correctly?</em> and{" "}
              <em>did Drift see that this repository is affected?</em> — over ground truth of different kinds.
              Negative controls are a property of the experiment, not the corpus: of the {datasets.length} runs
              below, only{" "}
              {narrative.negativeControls.withRealNegatives.map((d, i) => (
                <span key={d.runId}>
                  {i > 0 ? (i === narrative.negativeControls.withRealNegatives.length - 1 ? " and " : ", ") : ""}
                  <strong className="font-medium text-foreground">{d.title}</strong>
                </span>
              ))}{" "}
              carry real negative/control cases and can support a precision or a false-positive rate. The rest —{" "}
              {narrative.negativeControls.positiveOnly.map((d, i) => (
                <span key={d.runId}>
                  {i > 0 ? (i === narrative.negativeControls.positiveOnly.length - 1 ? " and " : ", ") : ""}
                  {d.title}
                </span>
              ))}{" "}
              — are positives only, including one of Kong&rsquo;s own two experiments here. Averaging across them
              would produce a figure that describes neither question.
            </p>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              So the results are grouped by question, each with its own denominator, and the metrics that the data
              cannot support are listed as refusals rather than quietly omitted.
            </p>
          </div>
        </section>

        {groups.map((group) => (
          <section key={group.datasetClass} className="pt-12">
            <h2 className={`${instrumentSerif.className} text-2xl text-landing`}>{classLabel(group.datasetClass)}</h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
              {group.datasetClass === "upstream-bc-detection"
                ? "Given what an upstream maintainer published — prose, or two versions of a library — does Drift work out what changed?"
                : "Given a real project at a real commit and an upgrade known to break it, does Drift see the update, decide the project is affected, and avoid telling the developer it is safe?"}
            </p>
            <div className="mt-5 space-y-5">
              {group.datasets.map((dataset) => (
                <BenchmarkCard key={dataset.runId} dataset={dataset} />
              ))}
            </div>
          </section>
        ))}

        <section className="pt-12">
          <h2 className={`${instrumentSerif.className} text-2xl text-landing`}>What these runs did not measure</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
            Listed because an absent number and a bad number look the same on a results page, and only one of them is a
            result. None of the following is reported as a zero anywhere above.
          </p>

          <div className="mt-5 space-y-3">
            <Weakness title="Repair, on every external corpus">
              These runs evaluate detection only. Repair can only be judged by the dataset&rsquo;s own oracle — BUMP&rsquo;s
              published container images, TimeMachine&rsquo;s date-filtered PyPI index, swe-bump-bench&rsquo;s{" "}
              <code className="font-mono text-[12px]">tsc</code> run after a real install — and the machine that produced
              these runs has no container runtime. The repair outcomes are <em>absent</em> from the case records rather
              than recorded as failures: an absent key means the question was not asked, where{" "}
              <code className="font-mono text-[12px]">false</code> would mean Drift tried and did not manage it.
            </Weakness>

            <Weakness title="Anything involving a coding agent">
              Drift&rsquo;s remediation hierarchy ends in a coding-agent handoff. No agent provider was configured for
              these runs, so no agent tier ran and no agent result is reported — not as zero, and not by quietly leaving
              the track out of the page. The harness distinguishes &ldquo;the agent was never asked&rdquo; from
              &ldquo;the agent was asked and failed&rdquo;, and only the second may enter a success rate.
            </Weakness>

            <Weakness title="Any general claim about an ecosystem">
              Each result is over the cases named on its card, from one corpus, evaluated on one machine on one date.
              &ldquo;Drift is X% accurate on Java&rdquo; does not follow from any of them, and is not claimed.
            </Weakness>
          </div>
        </section>

        <section className="pt-12">
          <h2 className={`${instrumentSerif.className} text-2xl text-landing`}>Known weaknesses these runs found</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
            Listed here rather than left in the per-dataset detail, because a benchmark page that only surfaces its good
            results is an advertisement.
          </p>

          <div className="mt-5 space-y-3">
            <Weakness title="Drift is markedly weaker on Java than on TypeScript, in the same way">
              The consumer-impact corpora ask one question of TypeScript, Python and Java, and the answers are not
              close. Given a project whose build a dependency upgrade really broke, Drift identified it as affected in{" "}
              {narrative.javaVsTypeScript.sweBump.affectedFraction} TypeScript cases (swe-bump-bench),{" "}
              {narrative.javaVsTypeScript.timeMachine.affectedFraction} Python cases (TimeMachine), and{" "}
              {narrative.javaVsTypeScript.bump.affectedFraction} Java cases (BUMP). False-safe verdicts run the other
              way: {narrative.javaVsTypeScript.sweBump.falseSafePercent}, {narrative.javaVsTypeScript.timeMachine.falseSafePercent}{" "}
              and {narrative.javaVsTypeScript.bump.falseSafePercent}. Detection of the update itself is strong
              everywhere — {narrative.javaVsTypeScript.sweBump.detectionFraction},{" "}
              {narrative.javaVsTypeScript.timeMachine.detectionFraction},{" "}
              {narrative.javaVsTypeScript.bump.detectionFraction} — so the gap is entirely in what happens after
              detection. Drift&rsquo;s own capability matrix predicts this shape: npm module names are declared by
              the manifest, where Java&rsquo;s must be recovered from a published artefact through japicmp.
            </Weakness>

            <Weakness title="On Java, Drift finds the upstream change and then fails to find it in your code">
              The worst result in this benchmark. On a {narrative.bumpSubset.selected}-case stratified subset of BUMP —
              real Java projects whose Maven build a dependency update broke — Drift detected the update in{" "}
              {narrative.bumpSubset.detectionFraction} scored cases and then told{" "}
              {narrative.bumpSubset.falseSafeFraction} of them they were not affected (
              {narrative.bumpSubset.falseSafePercent} false-safe). Stratifying by BUMP&rsquo;s own failure category —
              shown in full in this card&rsquo;s breakdown table below — shows where: Drift found the affected
              consumer in{" "}
              {narrative.bumpSubset.affectedByCategory.map((row, i) => (
                <span key={row.slice}>
                  {i > 0 ? (i === narrative.bumpSubset.affectedByCategory.length - 1 ? ", and " : ", ") : ""}
                  {row.rate} of the corpus&rsquo;s <code className="font-mono text-[12px]">{row.slice.replace("label: ", "")}</code> cases
                </span>
              ))}
              . Localization succeeds least on the categories where the break is not visible in a public API surface
              at all — a failed build-plugin rule or a behavioural test failure — which an API-surface diff cannot see
              by construction.
            </Weakness>

            <Weakness title="Drift's japicmp output parser drops class-level changes">
              On the current Roseau run, Drift&rsquo;s recall is {narrative.roseau.recallFraction} (
              {narrative.roseau.recallPercent}) — {narrative.roseau.fn} misses out of{" "}
              {narrative.roseau.recallDenominator} true positives. Every one of the {narrative.roseau.fn} misses
              was checked directly against japicmp&rsquo;s raw report for this jar pair, not inferred from the case
              label. Seven of the eight trace to one confirmed cause in{" "}
              <code className="font-mono text-[12px] text-brand-text">parseJapicmp</code>: the parser only turns a{" "}
              <code className="font-mono text-[12px]">MODIFIED METHOD</code>/<code className="font-mono text-[12px]">FIELD</code>/
              <code className="font-mono text-[12px]">CONSTRUCTOR</code> line into a finding — a{" "}
              <code className="font-mono text-[12px]">MODIFIED CLASS</code> or{" "}
              <code className="font-mono text-[12px]">MODIFIED INTERFACE</code> line produces nothing at all, even
              though japicmp itself reported it. That silently drops a class made abstract or final, a class changed
              to an interface (or back), and a nested interface whose access was reduced. One of those seven also
              carries a second, independent gap: its nested member line uses japicmp&rsquo;s{" "}
              <code className="font-mono text-[12px]">****</code> marker for a source-incompatible-but-binary-compatible
              change (a newly checked exception), which the parser&rsquo;s regex does not match at all — it only
              recognises <code className="font-mono text-[12px]">***!</code>, <code className="font-mono text-[12px]">---!</code> and{" "}
              <code className="font-mono text-[12px]">+++</code>.{" "}
              <strong className="font-medium text-foreground">The eighth miss is not this bug</strong> — a
              method&rsquo;s non-native-to-native change — because japicmp itself reports that method as unchanged for
              this pair; there is nothing in japicmp&rsquo;s own output for Drift to read. Both findings came from
              running japicmp directly against this benchmark&rsquo;s jars, not from re-reading the case labels.{" "}
              <strong className="font-medium text-foreground">Not fixed for this run.</strong> Changing the analyser
              after seeing the score and re-running would publish a number tuned on its own test set. The class-level
              drop plausibly also costs BUMP&rsquo;s localization rate above — a class-level change the parser never
              emits can&rsquo;t reach localization either — but that link is not independently confirmed the way the
              Roseau cause is, since it would require the same raw-output check against BUMP&rsquo;s own jars.
            </Weakness>

            <Weakness title="Drift's prose rules generalise poorly beyond changelog phrasing">
              On {narrative.kong.rq2.dataset.available.toLocaleString()} human-annotated real npm breaking changes,
              Drift read a breaking change out of the maintainer&rsquo;s own commit message in{" "}
              {narrative.kong.rq2.overallPercent} of cases — and {narrative.kong.rq2.withDetailPercent} where the
              message says more than the bare marker (versus {narrative.kong.rq2.withoutDetailPercent} where it
              doesn&rsquo;t), so most of the gap is Drift rather than the corpus. The rules are shaped for changelog
              and release-note phrasing.
            </Weakness>

            <Weakness title="Whether japicmp is installed changes the Java result completely">
              Without it, Drift cannot compute a Java API surface, correctly declines to conclude anything, and returns{" "}
              <code className="font-mono text-[12px]">insufficient-evidence</code>. With it, the same cases produce
              hundreds of API changes. That is honest behaviour rather than a bug — but it means a Java user without
              japicmp gets far less than these numbers suggest, and every run records which situation it was in.
            </Weakness>
          </div>
        </section>

        <section className="pt-12">
          <h2 className={`${instrumentSerif.className} text-2xl text-landing`}>How to check any of this</h2>
          <div className="mt-4 max-w-2xl space-y-3 text-sm leading-relaxed text-muted">
            <p>
              Each card&rsquo;s detail block carries the exact command that produced it. The artifacts are in the
              repository under <code className="font-mono text-[12.5px] text-brand-text">eval/results/</code>: a
              manifest naming the Drift commit and dataset version, the deterministic selection, the probed environment,
              one JSON line per case with its provenance and Drift&rsquo;s prediction, the metrics, and every exclusion
              with its reason.
            </p>
            <p>
              The datasets are not vendored — they belong to their authors and are cited on each card. {" "}
              <a
                href={`${GITHUB}/blob/main/benchmarks/README.md`}
                target="_blank"
                rel="noreferrer"
                className="text-brand-text underline decoration-dotted underline-offset-2"
              >
                benchmarks/README.md
              </a>{" "}
              has the fetch commands and checksums.
            </p>
            <p>
              What the harness measures, and the longer argument for what it refuses to measure, is in{" "}
              <a
                href={`${GITHUB}/blob/main/eval/README.md`}
                target="_blank"
                rel="noreferrer"
                className="text-brand-text underline decoration-dotted underline-offset-2"
              >
                eval/README.md
              </a>
              .
            </p>
          </div>

          <p className="mt-6 font-mono text-[11px] text-faint">
            Newest result on this page: {formatDate(generatedAt)}. Every figure is read from the run artifacts in the
            repository, not written into this page.
          </p>
        </section>
      </main>
    </div>
  );
}

function Weakness({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted">{children}</p>
    </div>
  );
}
