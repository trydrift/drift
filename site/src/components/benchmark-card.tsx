import {
  classLabel,
  fraction,
  formatDate,
  formatRate,
  percent,
  shortCommit,
  type BenchmarkDataset,
} from "@/lib/benchmarks";

/**
 * One dataset's result.
 *
 * Structured so that a sceptical reader meets the facts in the order that
 * decides whether the number below them means anything: what was asked, how
 * many cases it is over, what was excluded and why, then the result, then what
 * the result does not establish.
 *
 * The detail — provenance, per-slice breakdown, environment — is behind a
 * `<details>` rather than on another page. A caveat a reader has to navigate to
 * is a caveat most readers never see, and a caveat that pushes the numbers off
 * the first screen is a caveat nobody reads either.
 */
export function BenchmarkCard({ dataset }: { dataset: BenchmarkDataset }) {
  const excludedTotal = Object.values(dataset.excluded).reduce((total, count) => total + count, 0);

  return (
    <article className="rounded-xl border border-border bg-surface p-5 sm:p-6">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-base font-medium text-foreground">{dataset.title}</h3>
        <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[10.5px] uppercase tracking-wider text-faint">
          {dataset.ecosystem}
        </span>
        <a
          href={dataset.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="ml-auto text-xs text-brand-text underline decoration-dotted underline-offset-2"
        >
          Source
        </a>
      </header>

      <p className="mt-3 text-sm leading-relaxed text-muted">{dataset.evaluationQuestion}</p>

      {/* Accounting before results, always. */}
      <dl className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
        <Cell label="In the dataset" value={String(dataset.available)} />
        <Cell
          label="Evaluated"
          value={String(dataset.selected)}
          note={dataset.selectionMode === "stratified-sample" ? `stratified, seed ${dataset.selectionSeed}` : undefined}
        />
        <Cell
          label="Scored"
          value={String(dataset.scored)}
          note={dataset.notRun > 0 ? `${dataset.notRun} not yet run` : undefined}
        />
        <Cell
          label="Excluded"
          value={String(excludedTotal)}
          note={excludedTotal > 0 ? Object.keys(dataset.excluded).join(", ") : undefined}
        />
      </dl>

      {/* The one thing that makes precision possible, or its absence. */}
      <p className="mt-3 text-xs text-faint">
        {dataset.negativeControls > 0 ? (
          <>
            <strong className="font-medium text-muted">{dataset.negativeControls}</strong> of the scored cases are
            negative controls — changes labelled <em>not</em> breaking. They are what make a false positive measurable.
          </>
        ) : (
          <>
            <strong className="font-medium text-muted">No negative controls.</strong> Every case in this corpus is a
            known breakage, so precision and a false-positive rate are not defined here and are not shown.
          </>
        )}
      </p>

      {dataset.classification && dataset.confusion ? (
        <div className="mt-5">
          <div className="grid grid-cols-3 gap-2">
            <Metric label="Precision" big={fraction(dataset.classification.precision)} small={percent(dataset.classification.precision)} />
            <Metric label="Recall" big={fraction(dataset.classification.recall)} small={percent(dataset.classification.recall)} />
            <Metric
              label="F1"
              big={dataset.classification.f1 === null ? "n/a" : dataset.classification.f1.toFixed(3)}
              small="harmonic mean"
            />
          </div>
          <p className="mt-2 font-mono text-[11px] text-faint">
            TP {dataset.confusion.tp} · FP {dataset.confusion.fp} · TN {dataset.confusion.tn} · FN {dataset.confusion.fn}
          </p>
        </div>
      ) : null}

      {Object.keys(dataset.rates).length > 0 ? (
        <table className="mt-5 w-full text-sm">
          <tbody>
            {Object.entries(dataset.rates).map(([label, rate]) => {
              const interval = dataset.intervals[label];
              return (
                <tr key={label} className="border-t border-border/70">
                  <td className="py-1.5 pr-3 text-muted">{label}</td>
                  <td className="py-1.5 text-right font-mono text-[12.5px] text-foreground">
                    {formatRate(rate)}
                    {interval ? (
                      <span className="ml-2 text-[11px] text-faint">
                        95% {(interval.low * 100).toFixed(0)}–{(interval.high * 100).toFixed(0)}%
                      </span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}

      {dataset.baseline ? (
        <div className="mt-5 rounded-lg border border-border bg-background p-3">
          <p className="text-xs font-medium text-foreground">Trivial baseline on the same cases</p>
          <p className="mt-1 text-xs leading-relaxed text-faint">{dataset.baseline.description}</p>
          <p className="mt-2 font-mono text-[11.5px] text-muted">
            {dataset.baseline.name} — precision {formatRate(dataset.baseline.precision)}, recall{" "}
            {formatRate(dataset.baseline.recall)}
          </p>
        </div>
      ) : null}

      {Object.keys(dataset.missingRequirements).length > 0 ? (
        <div className="mt-5 rounded-lg border border-border bg-background p-3">
          <p className="text-xs font-medium text-foreground">Not measured here</p>
          <p className="mt-1 text-xs leading-relaxed text-faint">
            {Object.entries(dataset.missingRequirements)
              .map(([need, count]) => `${count} case(s) needed ${need}, which this machine does not have`)
              .join("; ")}
            . These are excluded from every rate rather than counted as failures — the questions were not asked, and a
            zero would claim they were.
          </p>
        </div>
      ) : null}

      <p className="mt-5 rounded-lg border border-border bg-background p-3 text-xs leading-relaxed text-muted">
        <strong className="font-medium text-foreground">What this does not establish.</strong>{" "}
        {dataset.doesNotEstablish}
      </p>

      <details className="group mt-4">
        <summary className="cursor-pointer list-none text-xs text-brand-text underline decoration-dotted underline-offset-2">
          Methodology, provenance and per-slice results
        </summary>

        <div className="mt-3 space-y-4 text-xs leading-relaxed text-muted">
          {dataset.notes ? <NotesBlock notes={dataset.notes} /> : null}

          <Section title="Provenance">
            <KeyValue k="Dataset version" v={dataset.datasetVersion} mono />
            <KeyValue k="Licence" v={dataset.licence} />
            <KeyValue k="Citation" v={dataset.citation} />
            <KeyValue
              k="Drift commit"
              v={`${shortCommit(dataset.driftCommit)}${dataset.driftTreeDirty ? " (working tree dirty)" : ""}`}
              mono
            />
            <KeyValue k="Run date" v={formatDate(dataset.runDate)} />
            {dataset.rescoredAt ? (
              <KeyValue
                k="Metrics recomputed"
                v={`${formatDate(dataset.rescoredAt)} at ${shortCommit(dataset.rescoredAtCommit ?? "unavailable")} — from the same recorded per-case results; the observations are unchanged`}
              />
            ) : null}
            <KeyValue k="Platform" v={dataset.platform} />
            <KeyValue k="Run id" v={dataset.runId} mono />
          </Section>

          {dataset.groundTruth ? (
            <Section title="Ground truth">
              <KeyValue k="Granularity" v={dataset.groundTruth.granularity} />
              <KeyValue k="Exhaustive at that granularity" v={dataset.groundTruth.exhaustive ? "yes" : "no"} />
              <KeyValue k="Metrics it can support" v={dataset.groundTruth.supports.join(", ") || "none"} />
              <p className="mt-1">{dataset.groundTruth.basis}</p>
            </Section>
          ) : null}

          {Object.keys(dataset.mappingCoverage).length > 0 ? (
            <Section title="Label mapping coverage">
              <p>
                This corpus&rsquo;s vocabulary is not Drift&rsquo;s. Only <code className="font-mono">exact</code> and{" "}
                <code className="font-mono">compatible</code> mappings are scored for category correctness;{" "}
                <code className="font-mono">ambiguous</code> and <code className="font-mono">unsupported</code> ones are
                counted here rather than forced into the nearest Drift kind.
              </p>
              <ul className="mt-1 font-mono text-[11.5px]">
                {Object.entries(dataset.mappingCoverage)
                  .sort()
                  .map(([status, count]) => (
                    <li key={status}>
                      {status}: {count}
                    </li>
                  ))}
              </ul>
            </Section>
          ) : null}

          {dataset.refusals.length > 0 ? (
            <Section title="Deliberately not reported">
              <ul className="space-y-1">
                {dataset.refusals.map((refusal) => (
                  <li key={refusal.metric}>
                    <span className="font-medium text-foreground">{refusal.metric}</span> — {refusal.reason}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {Object.keys(dataset.breakdown).length > 0 ? <Breakdown breakdown={dataset.breakdown} /> : null}

          <Section title="Toolchain the run actually had">
            <ul className="font-mono text-[11.5px]">
              {dataset.tools.map((tool) => (
                <li key={tool.tool} className={tool.available ? "" : "text-faint"}>
                  {tool.tool}: {tool.available ? tool.version : "not installed"}
                </li>
              ))}
            </ul>
          </Section>

          <Section title="Reproduce">
            <pre className="overflow-x-auto rounded border border-border bg-background p-2 font-mono text-[11.5px] text-foreground">
              {dataset.command}
            </pre>
            <p className="mt-1">
              Artifacts, including every per-case prediction and label, are in{" "}
              <code className="font-mono">eval/results/{dataset.runId}/</code>.
            </p>
          </Section>
        </div>
      </details>
    </article>
  );
}

function Cell({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="bg-surface px-3 py-2.5">
      <dt className="font-mono text-[10.5px] uppercase tracking-wider text-faint">{label}</dt>
      <dd className="mt-0.5 font-mono text-lg text-foreground">{value}</dd>
      {note ? <p className="text-[10.5px] text-faint">{note}</p> : null}
    </div>
  );
}

function Metric({ label, big, small }: { label: string; big: string; small: string }) {
  return (
    <div className="rounded-lg border border-brand-soft bg-brand-soft px-3 py-2.5">
      <p className="font-mono text-[10.5px] uppercase tracking-wider text-brand-text">{label}</p>
      <p className="mt-0.5 font-mono text-xl text-foreground">{big}</p>
      <p className="font-mono text-[11px] text-muted">{small}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="font-mono text-[10.5px] uppercase tracking-wider text-faint">{title}</h4>
      <div className="mt-1">{children}</div>
    </section>
  );
}

function KeyValue({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <p>
      <span className="text-faint">{k}: </span>
      <span className={mono ? "font-mono text-[11.5px] text-foreground" : "text-foreground"}>{v}</span>
    </p>
  );
}

/** The run's own notes, which are markdown-ish. Rendered as paragraphs, with `**bold**` and `` `code` `` honoured. */
function NotesBlock({ notes }: { notes: string }) {
  return (
    <div className="space-y-2 rounded-lg border border-border bg-background p-3">
      {notes
        .split("\n\n")
        .filter((paragraph) => paragraph.trim().length > 0)
        .map((paragraph, index) => (
          <p key={index}>{renderInline(paragraph)}</p>
        ))}
    </div>
  );
}

function renderInline(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((piece, index) => {
    if (piece.startsWith("**") && piece.endsWith("**")) {
      return (
        <strong key={index} className="font-medium text-foreground">
          {piece.slice(2, -2)}
        </strong>
      );
    }
    if (piece.startsWith("`") && piece.endsWith("`")) {
      return (
        <code key={index} className="font-mono text-[11.5px] text-brand-text">
          {piece.slice(1, -1)}
        </code>
      );
    }
    return <span key={index}>{piece}</span>;
  });
}

function Breakdown({ breakdown }: { breakdown: Record<string, Record<string, Rate>> }) {
  const columns = [...new Set(Object.values(breakdown).flatMap((row) => Object.keys(row)))].sort();
  const rows = Object.entries(breakdown).sort();

  return (
    <Section title="Breakdown">
      <p>
        Every rate again, split by the dataset&rsquo;s own labels. A pooled figure hides both directions of the
        interesting result, so it is never the only number here.
      </p>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[28rem] text-[11.5px]">
          <thead>
            <tr className="border-b border-border">
              <th className="py-1 pr-3 text-left font-mono font-normal text-faint">Slice</th>
              {columns.map((column) => (
                <th key={column} className="py-1 pr-3 text-right font-mono font-normal text-faint">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([slice, row]) => (
              <tr key={slice} className="border-b border-border/50">
                <td className="py-1 pr-3 font-mono text-muted">{slice}</td>
                {columns.map((column) => (
                  <td key={column} className="py-1 pr-3 text-right font-mono text-foreground">
                    {row[column] ? formatRate(row[column]) : "—"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

type Rate = BenchmarkDataset["rates"][string];
