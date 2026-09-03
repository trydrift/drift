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

      <header className="relative z-10 mx-auto flex max-w-[1600px] items-center gap-3 px-5 py-5 sm:px-10 lg:px-14">
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

      <main className="relative z-10 mx-auto max-w-[1600px] px-5 pb-24 sm:px-10 lg:px-14">
        <section className="pt-8 sm:pt-16">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
            <span className="text-faint">//</span> benchmarks
          </p>
          <h1 className={`${instrumentSerif.className} mt-3 max-w-3xl text-3xl text-landing sm:text-4xl`}>
            What Drift scores on other people&rsquo;s datasets
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-muted">
            Five public breaking-change datasets, tested with the same Drift build the CLI ships.
            The results come straight from the run artifacts.
          </p>

          <div className="mt-6 max-w-2xl rounded-xl border border-border bg-surface p-5">
            <h2 className="text-sm font-medium text-foreground">How to read this page</h2>
            <ul className="mt-3 space-y-3 text-sm leading-6 text-muted">
              <li className="flex gap-3">
                <span className="font-mono text-brand-text">01</span>
                <span>The datasets ask two different questions: can Drift identify the upstream change, and can it tell whether a repository is affected?</span>
              </li>
              <li className="flex gap-3">
                <span className="font-mono text-brand-text">02</span>
                <span>
                  Only {narrative.negativeControls.withRealNegatives.map((d, i) => (
                    <span key={d.runId}>
                      {i > 0 ? (i === narrative.negativeControls.withRealNegatives.length - 1 ? " and " : ", ") : ""}
                      <strong className="font-medium text-foreground">{d.title}</strong>
                    </span>
                  ))} include real negative controls, so only those runs support precision and false-positive rates.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="font-mono text-brand-text">03</span>
                <span>Each result keeps its own denominator. When the data cannot support a metric, the card says so.</span>
              </li>
            </ul>
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
            {group.datasetClass === "consumer-impact" && (
              <p className="mt-3 max-w-2xl rounded-lg border border-border bg-surface-hover/50 px-3.5 py-2.5 text-sm leading-6 text-muted">
                <strong className="font-medium text-foreground">TypeScript is where this is furthest along.</strong>{" "}
                swe-bump-bench&rsquo;s {narrative.javaVsTypeScript.sweBump.affectedFraction} affected-repository rate
                and {narrative.javaVsTypeScript.sweBump.falseSafePercent} false-safe rate are the numbers behind that.
                The Java (BUMP) and Python (TimeMachine) consumer-impact results below are earlier and weaker on the
                same questions — see the two Java cards under &ldquo;Known weaknesses&rdquo; — and are published as
                beta results, not a claim that they are launch-ready in the way the TypeScript numbers are.
              </p>
            )}
            <div className="mt-5 space-y-5">
              {group.datasets.map((dataset) => (
                <BenchmarkCard key={dataset.runId} dataset={dataset} />
              ))}
            </div>
          </section>
        ))}

        <section className="pt-12">
          <h2 className={`${instrumentSerif.className} text-2xl text-landing`}>What these runs did not measure</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
            Missing data and a zero score are different things. These questions were outside the runs above.
          </p>

          <div className="mt-5 space-y-3">
            <Weakness title="Repair, on every external corpus">
              These runs test detection, not repair. Repair needs each dataset&rsquo;s own test environment,
              including BUMP&rsquo;s containers and swe-bump-bench&rsquo;s installed <code className="font-mono text-[12px]">tsc</code> run.
              Those environments were unavailable, so repair results are absent rather than counted as failures.
            </Weakness>

            <Weakness title="Anything involving a coding agent">
              No agent provider was configured, so the agent tier never ran. The harness records that as
              &ldquo;not attempted,&rdquo; which keeps it out of the success rate.
            </Weakness>

            <Weakness title="Any general claim about an ecosystem">
              Each result is over the cases named on its card, from one corpus, evaluated on one machine on one date.
              &ldquo;Drift is X% accurate on Java&rdquo; does not follow from any of them, and is not claimed.
            </Weakness>
          </div>
        </section>

        <section className="pt-12">
          <h2 className={`${instrumentSerif.className} text-2xl text-landing`}>Known weaknesses these runs found</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
            The misses are as useful as the scores. Here is where Drift struggled, and what caused it.
          </p>

          <div className="mt-5 space-y-3">
            <Weakness title="Java localization trails TypeScript and Python">
              <p>The three consumer-impact datasets ask the same question: did Drift find that the project was affected?</p>
              <dl className="mt-3 grid gap-2 sm:grid-cols-3">
                <Metric label="TypeScript" value={narrative.javaVsTypeScript.sweBump.affectedFraction} />
                <Metric label="Python" value={narrative.javaVsTypeScript.timeMachine.affectedFraction} />
                <Metric label="Java" value={narrative.javaVsTypeScript.bump.affectedFraction} />
              </dl>
              <p className="mt-3">
                Update detection is strong in all three. The gap appears later, when Drift maps a Java API change back to consumer code.
              </p>
            </Weakness>

            <Weakness title="On Java, Drift finds the upstream change and then fails to find it in your code — beta, not launch-ready">
              <p>
                In BUMP&rsquo;s {narrative.bumpSubset.selected}-case Java subset, Drift detected the update in {narrative.bumpSubset.detectionFraction} cases.
                It still returned a false-safe verdict for {narrative.bumpSubset.falseSafeFraction} of them ({narrative.bumpSubset.falseSafePercent}).
                That is the number this page treats as blocking a general-availability claim for Java consumer-impact —
                it is published as beta, tracked for improvement, not presented as equivalent to the TypeScript result above.
              </p>
              <p className="mt-3">
                Some of the hardest failures live outside a public API surface entirely — build-plugin rules and
                behavioural test failures an API diff cannot see by itself. One specific localization gap has since
                been fixed: the Maven coordinate a dependency is fetched under is frequently not the Java package it
                ships (a Jenkins plugin&rsquo;s <code className="font-mono text-[12px]">groupId</code> is nothing like its <code className="font-mono text-[12px]">hudson.*</code> packages),
                so a consumer file that plainly imported and used the changed type was never searched. Re-running
                this exact subset after that fix left the numbers on this card unmoved, which says the fix does not
                reach this particular corpus&rsquo; packages — not that nothing changed. The remaining gap is still
                unidentified.
              </p>
            </Weakness>

            <Weakness title="Drift's prose rules generalise beyond changelog phrasing, with real limits">
              <p>
                On {narrative.kong.rq2.dataset.available.toLocaleString()} human-annotated real npm breaking changes,
                Drift reads a breaking change out of the maintainer&rsquo;s own commit message in{" "}
                {narrative.kong.rq2.overallPercent} of cases — {narrative.kong.rq2.withDetailPercent} where the
                message says more than the bare marker, {narrative.kong.rq2.withoutDetailPercent} where it doesn&rsquo;t.
                Naming the right <em>kind</em> of change is the harder question: {narrative.kong.rq2.categoryFraction} of
                the scoreable cases ({narrative.kong.rq2.categoryPercent}).
              </p>
              <p className="mt-3">
                The ceiling there is structural, not a rule the corpus is waiting for: about a fifth of the scoreable
                cases carry no description at all beyond the bare marker, and prose alone cannot name a kind for a
                sentence that says nothing. Closing the rest needs the published-artefact API diff, a different Drift
                capability than the prose interpreter this corpus tests.
              </p>
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
      <div className="mt-2 max-w-3xl text-sm leading-6 text-muted">{children}</div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-surface-hover/70 px-3 py-2">
      <dt className="text-xs text-faint">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm text-foreground">{value} affected</dd>
    </div>
  );
}
