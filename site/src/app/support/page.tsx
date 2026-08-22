import type { Metadata } from "next";
import Link from "next/link";
import { instrumentSerif } from "@/lib/fonts";
import { Backdrop } from "@/components/backdrop";
import { ThemeToggle } from "@/components/theme-toggle";
import { Ecosystems } from "@/components/ecosystems";
import { loadRecordings } from "@/lib/load";

export const metadata: Metadata = {
  title: "Drift ecosystem support",
  description: "Every ecosystem Drift analyzes, and exactly how deep that support goes, stage by stage.",
};

const GITHUB = "https://github.com/trydrift/Drift";

/**
 * The full capability matrix, moved off the homepage.
 *
 * The homepage now shows a one-line summary (count + the four stages that
 * matter most) and a link here — this page is where the complete,
 * stage-by-stage grid lives for a reader who wants it. Same data, same
 * component (`Ecosystems`), so nothing here can drift from what the homepage
 * summarizes or from `docs/support.md`.
 */
export default function Support() {
  const recordings = loadRecordings();

  return (
    <div className="relative min-h-screen">
      <Backdrop />

      <header className="relative z-10 mx-auto flex max-w-5xl items-center gap-3 px-5 py-5 sm:px-8">
        <Link href="/" className={`${instrumentSerif.className} text-2xl text-landing`}>
          Drift
        </Link>
        <nav className="ml-auto flex items-center gap-1 sm:gap-2">
          <Link
            href="/"
            className="rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            Home
          </Link>
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
            <span className="text-faint">//</span> ecosystem support
          </p>
          <h1 className={`${instrumentSerif.className} mt-3 max-w-2xl text-3xl text-landing sm:text-4xl`}>
            Every ecosystem, and how far Drift actually gets in each
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
            That depth varies by ecosystem. The grade is computed &mdash; not hand-typed &mdash;
            from whether Drift can diff the real API, resolve module names from the package
            itself, and run the ecosystem&rsquo;s own build and tests.
          </p>

          <div className="mt-7">
            <Ecosystems recorded={new Set(recordings.map((r) => r.ecosystem))} />
          </div>

          <p className="mt-5 text-[13px] text-muted">
            The same breakdown, stage by stage, is in{" "}
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
      </main>

      <footer className="relative z-10 border-t border-border bg-background/60">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-5 py-6 text-xs text-faint sm:px-8">
          <span className={`${instrumentSerif.className} text-base text-landing`}>Drift</span>
          <a href={GITHUB} target="_blank" rel="noreferrer" className="transition-colors hover:text-foreground">
            GitHub
          </a>
          <Link href="/" className="ml-auto transition-colors hover:text-foreground">
            Back home
          </Link>
        </div>
      </footer>
    </div>
  );
}
