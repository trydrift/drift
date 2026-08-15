import { instrumentSerif } from "@/lib/fonts";
import { Backdrop } from "@/components/backdrop";
import { CopyCommand } from "@/components/copy-command";
import { Code, GhIcon, GhPanel, type CodeLine } from "@/components/gh";
import { Demo } from "@/components/demo";
import { Ecosystems } from "@/components/ecosystems";
import { Pipeline } from "@/components/pipeline";
import { ActionFlow } from "@/components/action-flow";
import { Terminal } from "@/components/terminal";
import { ThemeToggle } from "@/components/theme-toggle";
import { loadRecordings } from "@/lib/load";
import { totalsOf, type Recording } from "@/lib/recordings";

/**
 * The landing page.
 *
 * One argument, made in one scroll: dependency tools tell you a version moved,
 * Drift tells you whether it matters *to your code* — and it will show you,
 * right here, on a repository you have heard of, without asking you to install
 * anything first.
 *
 * The demo is deliberately above the feature list. A visitor who watches thirty
 * seconds of a real analysis of Kubernetes understands the product better than
 * any three paragraphs could explain it, and the paragraphs are there for the
 * ones who want to know how it works after they already believe it does.
 */

const GITHUB = "https://github.com/trydrift/Drift";
const MARKETPLACE = "https://marketplace.visualstudio.com/items?itemName=drift.drift";

/** Both inputs are optional — see `examples/workflows/`. */
const WORKFLOW: CodeLine[] = [{ n: 18, text: "- uses: trydrift/drift@v0" }];

export default function Home() {
  const recordings = loadRecordings();
  const languages = [...new Set(recordings.map((r) => r.language))];
  const proof = summarizeRecordings(recordings);

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
          <a
            href="#ecosystems"
            className="hidden rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-surface-hover hover:text-foreground sm:block"
          >
            Ecosystems
          </a>
          <a
            href="#action"
            className="hidden rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-surface-hover hover:text-foreground sm:block"
          >
            Action
          </a>
          <a
            href="/configure/"
            className="hidden rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-surface-hover hover:text-foreground sm:block"
          >
            Configure
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
            Your dependency bot says 47 updates.
            <br />
            Drift says which three break your code.
          </h1>
          <p className="mt-5 max-w-2xl text-[15px] leading-relaxed text-muted sm:text-base">
            Drift checks what changed upstream, then searches{" "}
            <em className="not-italic text-foreground">your</em> repository for the exact lines
            that use it. Every claim links to its evidence, and anything it can&rsquo;t verify is
            flagged as a gap — never softened into a pass.
          </p>

          {/* Installing is the primary action. The demo below is what convinces
              someone, but a visitor who is already convinced should not have to
              scroll past it to find out how to actually get Drift. */}
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
            <a
              href={GITHUB}
              target="_blank"
              rel="noreferrer"
              className="rounded-full border border-border bg-surface px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover"
            >
              View on GitHub
            </a>
          </div>

          <p className="mt-4 font-mono text-xs text-muted">
            <CopyCommand text="npm install -g @usedrift/cli">
              <span className="text-faint">$</span> npm install -g @usedrift/cli
            </CopyCommand>
          </p>

          <p className="mt-5 font-mono text-xs text-faint">
            {languages.join(" · ")}
          </p>

          <ProofStrip proof={proof} />
        </section>

        {/* ── The demo ────────────────────────────────────────────────── */}
        <section id="demo" className="scroll-mt-8 pt-16 sm:pt-24">
          <h2
            className={`${instrumentSerif.className} text-2xl text-landing sm:text-3xl`}
          >
            Not a Mock-Up. A Recording.
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
            Drift clones repos, calls registries, and runs package managers — none of that works in
            a browser. So each panel below is a recording of a real run against a real project,
            replayed here at its original pace. The commit is linked; go check it.
          </p>

          <div className="mt-7">
            <Demo recordings={recordings} />
          </div>
        </section>

        {/* ── Coverage ────────────────────────────────────────────────── */}
        <section id="ecosystems" className="scroll-mt-8 pt-16 sm:pt-24">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
            <span className="text-faint">//</span> sixteen ecosystems, graded
          </p>
          <h2 className={`${instrumentSerif.className} mt-3 text-2xl text-landing sm:text-3xl`}>
            How Far Drift Gets, per Ecosystem
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
            Every ecosystem below has a recording above, including the ones where Drift does less.
            The grade is computed, not hand-typed, from three things: whether Drift can diff the
            real API, whether it resolves module names from the package itself rather than a
            guess, and whether it can run the ecosystem&rsquo;s own build and tests.
          </p>

          <div className="mt-7">
            <Ecosystems recorded={new Set(recordings.map((r) => r.ecosystem))} />
          </div>

          <p className="mt-6 text-[13px] text-muted">
            The full breakdown, stage by stage, is in{" "}
            <a
              href={`${GITHUB}/blob/main/docs/support.md`}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-brand-text underline decoration-dotted underline-offset-4"
            >
              docs/support.md
            </a>
            , generated from the same source.
          </p>
        </section>

        {/* ── The point ───────────────────────────────────────────────── */}
        <section className="pt-16 sm:pt-24">
          <div className="grid gap-8 lg:grid-cols-[0.95fr_1.05fr] lg:items-center">
            <div>
              <h2 className={`${instrumentSerif.className} text-2xl text-landing sm:text-3xl`}>
                The Number That Matters Is the Small One
              </h2>
              <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
                Drift separates upstream noise from code you actually own. The report is allowed to
                say three different things: safe here, affected here, or not verified.
              </p>
              <VerdictStack proof={proof} />
            </div>

            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
              <OutcomeCard
                icon="quiet"
                metric={String(proof.clean)}
                label="Safe Here"
                detail="Upstream changed; your repository does not call the changed surface."
              />
              <OutcomeCard
                icon="target"
                metric={String(proof.affected)}
                label="Need Attention"
                detail={`${proof.sites} exact call site${proof.sites === 1 ? "" : "s"} linked to files and lines.`}
              />
              <OutcomeCard
                icon="gap"
                metric={String(proof.unchecked)}
                label="Not Verified"
                detail="Missing evidence is shown as a gap, not softened into a pass."
              />
            </div>
          </div>
        </section>

        <Pipeline />

        {/* ── The Action ──────────────────────────────────────────────── */}
        <section id="action" className="scroll-mt-8 pt-16 sm:pt-24">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
            <span className="text-faint">//</span> on every dependency change
          </p>
          <h2 className={`${instrumentSerif.className} mt-3 text-2xl text-landing sm:text-3xl`}>
            The Same Analysis, Running Without You
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
            The Action is the only surface where Drift runs unattended, so here&rsquo;s exactly what
            it&rsquo;s allowed to do. By default it opens no pull request — it analyzes, posts a
            check, files an issue with the plan, and waits for a yes. Autonomy is opt-in per
            repository, and every guardrail downgrades a run to an approval request instead of
            skipping it.
          </p>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
            It&rsquo;s the same pipeline, but not always the same result: Drift&rsquo;s strongest
            evidence needs that ecosystem&rsquo;s toolchain on the runner. Where it&rsquo;s missing,
            Drift falls back to release notes and says so. The shipped workflow sets up Go, with
            commented-out steps for the rest.
          </p>

          <div className="mt-7 grid gap-4 lg:grid-cols-[1.15fr_1fr] lg:items-start">
            <ActionFlow />

            <div className="grid gap-4">
              <GhPanel icon="file" name=".github/workflows/drift.yml" meta="1 line">
                <Code lines={WORKFLOW} />
              </GhPanel>

              {/* What the run leaves behind, in the two places GitHub puts it.
                  The default install produces exactly these two artefacts and
                  no third one — which is the section's whole claim, so it is
                  drawn rather than asserted. */}
              <div className="overflow-hidden rounded-2xl border border-border bg-surface">
                <p className="border-b border-border bg-surface-hover/40 px-4 py-2 font-mono text-[11px] text-faint">
                  what the default run leaves behind
                </p>
                <div className="flex items-start gap-2.5 border-b border-border px-4 py-3">
                  <GhIcon icon="check" className="mt-0.5 size-4 shrink-0 text-brand" />
                  <div className="min-w-0">
                    <p className="text-[12.5px] font-medium text-foreground">
                      drift / analyze — <span className="text-brand-text">affected</span>
                    </p>
                    <p className="mt-0.5 text-[12px] leading-relaxed text-muted">
                      A check run on the commit, next to your tests.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-2.5 px-4 py-3">
                  <GhIcon icon="issue" className="mt-0.5 size-4 shrink-0 text-brand" />
                  <div className="min-w-0">
                    <p className="text-[12.5px] font-medium text-foreground">
                      #482 Upgrade plan: w3lib 1.17.0 → 2.4.1
                    </p>
                    <p className="mt-0.5 text-[12px] leading-relaxed text-muted">
                      The plan, the evidence, and a comment box. Nothing is pushed until someone
                      writes <code className="font-mono text-[11.5px] text-brand-text">/drift apply</code>.
                    </p>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-border bg-surface/50 p-5">
                <p className="text-[13px] leading-relaxed text-muted">
                  <strong className="font-medium text-foreground">
                    Copilot is only needed for fixes Drift can&rsquo;t resolve on its own.
                  </strong>{" "}
                  The built-in <code className="font-mono text-[11.5px] text-brand-text">GITHUB_TOKEN</code>{" "}
                  covers everything else. Without it, Drift still analyzes and applies deterministic
                  fixes — anything left over, it stops and asks instead of guessing. Add{" "}
                  <code className="font-mono text-[11.5px] text-brand-text">copilot-token</code> for
                  agent fallback on the rest.
                </p>
                <p className="mt-3 text-[13px] leading-relaxed text-muted">
                  <strong className="font-medium text-foreground">Not ready for Drift to make changes?</strong>{" "}
                  <code className="font-mono text-[11.5px] text-brand-text">dry-run: true</code>{" "}
                  produces the full report without creating branches, issues, pull requests, or
                  agent tasks.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ── Get it ──────────────────────────────────────────────────── */}
        <section id="install" className="scroll-mt-8 pt-16 sm:pt-24">
          <h2 className={`${instrumentSerif.className} text-2xl text-landing sm:text-3xl`}>
            Three Ways In
          </h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <EntryPoint
              icon="editor"
              title="VS Code"
              command="Drift for VS Code"
              action={{ label: "Install from the Marketplace", href: MARKETPLACE, external: true }}
            >
              Affected lines inline, each linked to the upstream change that caused it. Nothing to
              configure — open a repo and it starts.
            </EntryPoint>
            <EntryPoint
              icon="terminal"
              title="CLI"
              commands={["npm install -g @usedrift/cli", "drift analyze"]}
              action={{ label: "Read the CLI Docs", href: `${GITHUB}#try-it-with-zero-permissions`, external: true }}
            >
              Full report against your working tree. <code className="font-mono text-brand-text">analyze</code> writes
              nothing and needs no token — the safe first command.
            </EntryPoint>
            <EntryPoint
              icon="action"
              title="GitHub Action"
              command="uses: trydrift/drift@v0"
              action={{ label: "Copy the Example Workflow", href: `${GITHUB}/blob/main/examples/workflows/drift.yml`, external: true }}
            >
              Checks first, approval next, pull request only after you allow it.{" "}
              <a href="#action" className="text-brand-text underline decoration-dotted underline-offset-2">See the run.</a>{" "}
              Or <a href="/configure/" className="text-brand-text underline decoration-dotted underline-offset-2">build your own drift.yml</a>.
            </EntryPoint>
          </div>

          <Terminal />
        </section>
      </main>

      <footer className="relative z-10 border-t border-border bg-background/60">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-5 py-6 text-xs text-faint sm:px-8">
          <span className={`${instrumentSerif.className} text-base text-landing`}>Drift</span>
          <a href={GITHUB} target="_blank" rel="noreferrer" className="transition-colors hover:text-foreground">
            GitHub
          </a>
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

function ProofStrip({ proof }: { proof: ProofSummary }) {
  const items = [
    { value: proof.recordings, label: "recorded runs" },
    { value: proof.ecosystems, label: "ecosystems" },
    { value: proof.packages, label: "packages checked" },
    { value: proof.sites, label: "linked code sites" },
  ];

  return (
    <div className="mt-8 grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="bg-surface/75 px-4 py-3">
          <p className="font-mono text-2xl text-landing tabular">{item.value}</p>
          <p className="mt-1 text-[11px] uppercase tracking-[0.16em] text-faint">{item.label}</p>
        </div>
      ))}
    </div>
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
    <div className="mt-6">
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
    </div>
  );
}

function OutcomeCard({
  icon,
  metric,
  label,
  detail,
}: {
  icon: "quiet" | "target" | "gap";
  metric: string;
  label: string;
  detail: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface/70 p-4">
      <div className="flex items-start gap-3">
        <IconBadge icon={icon} />
        <div className="min-w-0">
          <p className="font-mono text-2xl leading-none text-landing tabular">{metric}</p>
          <h3 className="mt-1 text-sm font-semibold text-foreground">{label}</h3>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">{detail}</p>
        </div>
      </div>
    </div>
  );
}

/**
 * One way in, with the next step attached.
 *
 * This section used to name the three surfaces and stop there, which left the
 * page's last word weaker than its first: a visitor who had just been
 * persuaded had to go and find the install themselves. Each card now carries
 * the thing you would actually do next — the Marketplace listing, the two
 * commands in order, the workflow file to copy — in the same frame the section
 * already used.
 *
 * The CLI card shows two lines because the honest first run is two lines: the
 * install, then `drift analyze`, which writes nothing and needs no token. One
 * line would have to be either the install (which does nothing on its own) or
 * the command (which is not runnable yet).
 */
function EntryPoint({
  icon,
  title,
  command,
  commands,
  action,
  children,
}: {
  icon: "terminal" | "editor" | "action";
  title: string;
  command?: string;
  commands?: readonly string[];
  action?: { label: string; href: string; external?: boolean };
  children: React.ReactNode;
}) {
  const lines = commands ?? (command ? [command] : []);

  return (
    <div className="flex flex-col rounded-lg border border-border bg-surface/70 p-4">
      <IconBadge icon={icon} />
      <h3 className="mt-3 text-sm font-semibold text-foreground">{title}</h3>
      <div className="mt-2 flex flex-col items-start gap-1">
        {lines.map((line) => (
          <CopyCommand
            key={line}
            text={line}
            className="bg-surface-hover px-2 py-1 font-mono text-[11px] text-brand-text"
          >
            {line}
          </CopyCommand>
        ))}
      </div>
      <p className="mt-3 mb-4 text-[13px] leading-relaxed text-muted">{children}</p>
      {action && (
        <a
          href={action.href}
          {...(action.external ? { target: "_blank", rel: "noreferrer" } : {})}
          className="mt-auto inline-flex w-fit items-center gap-1 rounded-full border border-brand/25 bg-brand-soft px-3 py-1.5 text-[12px] font-medium text-brand-text transition-colors hover:bg-surface-hover"
        >
          {action.label}
          <span aria-hidden>→</span>
        </a>
      )}
    </div>
  );
}

function IconBadge({ icon }: { icon: "quiet" | "target" | "gap" | "terminal" | "editor" | "action" }) {
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-brand/25 bg-brand-soft text-brand-text">
      <VisualIcon icon={icon} />
    </span>
  );
}

function VisualIcon({ icon }: { icon: "quiet" | "target" | "gap" | "terminal" | "editor" | "action" }) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      {icon === "quiet" && (
        <>
          <path {...common} d="m5 12 4 4L19 6" />
          <path {...common} d="M4 20h16" />
        </>
      )}
      {icon === "target" && (
        <>
          <circle {...common} cx="12" cy="12" r="8" />
          <circle {...common} cx="12" cy="12" r="3" />
          <path {...common} d="M12 2v3M12 19v3M2 12h3M19 12h3" />
        </>
      )}
      {icon === "gap" && (
        <>
          <path {...common} d="M12 8v5" />
          <path {...common} d="M12 17h.01" />
          <path {...common} d="M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0Z" />
        </>
      )}
      {icon === "terminal" && (
        <>
          <path {...common} d="m5 7 5 5-5 5" />
          <path {...common} d="M12 17h7" />
        </>
      )}
      {icon === "editor" && (
        <>
          <rect {...common} x="4" y="4" width="16" height="16" rx="2" />
          <path {...common} d="M8 8h8M8 12h5M8 16h7" />
        </>
      )}
      {icon === "action" && (
        <>
          <path {...common} d="M6 4v6a6 6 0 0 0 12 0V4" />
          <path {...common} d="M8 20h8" />
          <path {...common} d="M12 16v4" />
        </>
      )}
    </svg>
  );
}
