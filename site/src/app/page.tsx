import { instrumentSerif } from "@/lib/fonts";
import { Demo } from "@/components/demo";
import { Pipeline } from "@/components/pipeline";
import { ActionFlow } from "@/components/action-flow";
import { Terminal } from "@/components/terminal";
import { ThemeToggle } from "@/components/theme-toggle";
import { loadRecordings } from "@/lib/load";

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

export default function Home() {
  const recordings = loadRecordings();
  const languages = [...new Set(recordings.map((r) => r.language))];

  return (
    <div className="dot-bg min-h-screen">
      <header className="mx-auto flex max-w-5xl items-center gap-3 px-5 py-5 sm:px-8">
        <span className={`${instrumentSerif.className} text-2xl text-landing`}>Drift</span>
        <nav className="ml-auto flex items-center gap-1 sm:gap-2">
          <a
            href="#how"
            className="rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            How it works
          </a>
          <a
            href="#action"
            className="hidden rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-surface-hover hover:text-foreground sm:block"
          >
            Action
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

      <main className="mx-auto max-w-5xl px-5 pb-24 sm:px-8">
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
            Drift reads the actual API surface of both versions, works out what really changed, then
            searches <em className="not-italic text-foreground">your</em> repository for the exact
            lines that use it. Every claim carries a citation you can open. It also checks the
            versions you already have installed — because plenty of code is broken today, with no
            upgrade in sight.
          </p>

          <div className="mt-7 flex flex-wrap items-center gap-3">
            <a
              href="#demo"
              className="rounded-full bg-brand px-5 py-2.5 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200"
            >
              Watch a real analysis
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

          <p className="mt-5 font-mono text-xs text-faint">
            {languages.join(" · ")}
          </p>
        </section>

        {/* ── The demo ────────────────────────────────────────────────── */}
        <section id="demo" className="scroll-mt-8 pt-16 sm:pt-24">
          <h2
            className={`${instrumentSerif.className} text-2xl text-landing sm:text-3xl`}
          >
            Not a mock-up. A recording.
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
            Drift clones repositories, calls registries and runs package managers, so it cannot run
            in a browser. Instead each of these is a real run against a real project, captured with
            every progress event and the timestamp it happened at — replayed here at its original
            cadence. The commit is linked; go and check it.
          </p>

          <div className="mt-7">
            <Demo recordings={recordings} />
          </div>
        </section>

        {/* ── The point ───────────────────────────────────────────────── */}
        <section className="pt-16 sm:pt-24">
          <h2 className={`${instrumentSerif.className} text-2xl text-landing sm:text-3xl`}>
            The number that matters is the small one
          </h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <Point title="Most upgrades are fine">
              A package can ship a hundred breaking changes and touch nothing you wrote. Drift says
              so, out loud, rather than making you read a changelog to find out — that is most of
              the value, and no tool that only shouts can deliver it.
            </Point>
            <Point title="Some are not, and it names them">
              When a change does land on your code, you get the file, the line, the symbol, and what
              the fix has to accomplish. Not &ldquo;review the migration guide&rdquo;.
            </Point>
            <Point title="&ldquo;Could not check&rdquo; is an answer">
              A changelog Drift failed to fetch is reported as unchecked, never as clean. Silently
              rounding the two together is how a tool talks someone into shipping a break.
            </Point>
          </div>
        </section>

        {/* ── Already broken ──────────────────────────────────────────── */}
        <section className="pt-16 sm:pt-24">
          <div className="rounded-2xl border border-brand/25 bg-gradient-to-br from-brand/[0.07] via-transparent to-transparent bg-origin-border p-6 sm:p-8">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-brand-text">
              the question nothing else asks
            </p>
            <h2 className={`${instrumentSerif.className} mt-3 text-2xl text-landing sm:text-3xl`}>
              Some of your code is already broken
            </h2>
            <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted">
              A range like <code className="rounded bg-surface-hover px-1.5 py-0.5 font-mono text-xs text-brand-text">^4.0.0</code>{" "}
              is a standing instruction to install anything on 4.x — so a resolver did, during a
              lockfile refresh nobody read. Your code still assumes the 4.x it was written against.
              Everything removed in between is live in your repository <em className="not-italic text-foreground">right now</em>.
            </p>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
              <code className="rounded bg-surface-hover px-1.5 py-0.5 font-mono text-xs text-brand-text">drift audit</code>{" "}
              analyses that window — from the oldest version your range admits to the version
              actually installed — and reports what already bites. These findings do not go away by
              upgrading.
            </p>
          </div>
        </section>

        <Pipeline />

        {/* ── The Action ──────────────────────────────────────────────── */}
        <section id="action" className="scroll-mt-8 pt-16 sm:pt-24">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
            <span className="text-faint">//</span> on every dependency change
          </p>
          <h2 className={`${instrumentSerif.className} mt-3 text-2xl text-landing sm:text-3xl`}>
            The same analysis, running without you
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
            The Action is the only surface where Drift acts while nobody is watching, so what it is
            allowed to do is worth knowing before you enable it. Out of the box it opens no pull
            request: it analyses, posts a check, files an issue with the plan, and waits for someone
            to say yes. Autonomy is a setting you turn on per repository, and every guardrail
            downgrades an automatic run to an approval request rather than dropping it.
          </p>

          <div className="mt-7 grid gap-4 lg:grid-cols-[1.15fr_1fr] lg:items-start">
            <ActionFlow />

            <div className="rounded-2xl border border-border bg-surface/50 p-5">
              <h3 className="text-sm font-semibold text-foreground">One step in a workflow</h3>
              <div className="mt-3 overflow-x-auto rounded-xl border border-border bg-[var(--pre-bg)] p-3.5">
                <pre className="font-mono text-[12px] leading-relaxed text-foreground">
{`- uses: trydrift/drift@v0
  with:
    repo-token: \${{ secrets.GITHUB_TOKEN }}
    copilot-token: \${{ secrets.DRIFT_COPILOT_TOKEN }}`}
                </pre>
              </div>
              <p className="mt-3 text-[13px] leading-relaxed text-muted">
                The built-in <code className="font-mono text-[11.5px] text-brand-text">GITHUB_TOKEN</code>{" "}
                covers everything except invoking Copilot, which GitHub bills per seat and so
                requires a user-scoped token. Omit it entirely and Drift runs in analysis-only mode:
                it still finds and reports everything, it just cannot dispatch the fix.
              </p>
              <p className="mt-3 text-[13px] leading-relaxed text-muted">
                Not ready to grant write access at all?{" "}
                <code className="font-mono text-[11.5px] text-brand-text">dry-run: true</code>{" "}
                produces the whole report and creates nothing.
              </p>
            </div>
          </div>
        </section>

        {/* ── Get it ──────────────────────────────────────────────────── */}
        <section id="install" className="scroll-mt-8 pt-16 sm:pt-24">
          <h2 className={`${instrumentSerif.className} text-2xl text-landing sm:text-3xl`}>
            Three ways in
          </h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <Point title="CLI">
              <code className="font-mono text-xs text-brand-text">drift analyze</code> runs the full
              pipeline against your working tree and prints the report. It writes nothing, and needs
              no token.
            </Point>
            <Point title="VS Code">
              Scan your dependencies, then see every affected line flagged inline in the Problems
              panel — including the ones that are already broken.
            </Point>
            <Point title="GitHub Action">
              On every dependency change, a check run and — once you have said yes — a pull request
              that explains itself. <a href="#action" className="text-brand-text underline decoration-dotted underline-offset-2">See the whole run.</a>
            </Point>
          </div>

          <Terminal />
        </section>
      </main>

      <footer className="border-t border-border">
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

function Point({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-surface/50 p-5">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="mt-2 text-[13px] leading-relaxed text-muted">{children}</p>
    </div>
  );
}
