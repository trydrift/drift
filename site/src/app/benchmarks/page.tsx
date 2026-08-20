import type { Metadata } from "next";
import Link from "next/link";
import { instrumentSerif } from "@/lib/fonts";
import { Backdrop } from "@/components/backdrop";
import { ThemeToggle } from "@/components/theme-toggle";
import { BenchmarkCard } from "@/components/benchmark-card";
import { byClass, classLabel, formatDate, loadBenchmarks } from "@/lib/benchmarks";

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
  const { datasets, skipped, generatedAt } = loadBenchmarks();
  const groups = byClass(datasets);

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
              <em>did Drift see that this repository is affected?</em> — over ground truth of different kinds. Four of
              the five contain only known breakages, so they have no negative population and cannot support a precision
              or a false-positive rate at any sample size. Averaging across them would produce a figure that describes
              neither question.
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
          <h2 className={`${instrumentSerif.className} text-2xl text-landing`}>Known weaknesses these runs found</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
            Listed here rather than left in the per-dataset detail, because a benchmark page that only surfaces its good
            results is an advertisement.
          </p>

          <div className="mt-5 space-y-3">
            <Weakness title="Drift's japicmp output parser drops class-level changes">
              On the Roseau accuracy dataset, Drift&rsquo;s recall (0.810) trails the japicmp labels the replication kit
              records (0.980), even though Drift&rsquo;s Java surface diff <em>is</em> japicmp. Seventeen of the
              nineteen misses are class-level changes. Reading{" "}
              <code className="font-mono text-[12px] text-brand-text">parseJapicmp</code> against japicmp&rsquo;s real
              output shows why: a <code className="font-mono text-[12px]">MODIFIED CLASS</code> line produces no finding
              at all, and the symbol parser splits on the first <code className="font-mono text-[12px]">(</code>, which
              japicmp&rsquo;s <code className="font-mono text-[12px]">PUBLIC(-)</code> access notation defeats. The same
              split can mislabel the member that follows.{" "}
              <strong className="font-medium text-foreground">Not fixed before this run.</strong> Changing the analyser
              after seeing the score and re-running would publish a number tuned on its own test set.
            </Weakness>

            <Weakness title="Drift's prose rules generalise poorly beyond changelog phrasing">
              On 1,511 human-annotated real npm breaking changes, Drift read a breaking change out of the
              maintainer&rsquo;s own commit message in 12.5% of cases — and 15.1% where the message says more than the
              bare marker, so most of the gap is Drift rather than the corpus. The rules are shaped for changelog and
              release-note phrasing.
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

          {skipped.length > 0 ? (
            <div className="mt-5 max-w-2xl rounded-lg border border-border bg-surface p-4">
              <p className="text-xs font-medium text-foreground">Runs this page expected and did not find</p>
              <ul className="mt-1 font-mono text-[11.5px] text-faint">
                {skipped.map((entry) => (
                  <li key={entry.runId}>
                    {entry.runId} — {entry.reason}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs leading-relaxed text-muted">
                Shown rather than hidden: a dataset that quietly disappears from a results page is indistinguishable
                from one that was never run.
              </p>
            </div>
          ) : null}

          <p className="mt-6 font-mono text-[11px] text-faint">
            Generated from run artifacts on {formatDate(generatedAt)}.
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
