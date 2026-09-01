import type { Metadata } from "next";
import Link from "next/link";
import { instrumentSerif } from "@/lib/fonts";
import { Backdrop } from "@/components/backdrop";
import { ThemeToggle } from "@/components/theme-toggle";
import { ConfigureForm } from "@/components/configure-form";
import { WORKFLOW_TEMPLATE, OUTDATED_WORKFLOW_TEMPLATE } from "@/lib/action-templates";

export const metadata: Metadata = {
  title: "Configure the Drift Action",
  description:
    "Pick the options you want and download a ready-to-commit .github/drift.yml and workflow file.",
};

const GITHUB = "https://github.com/trydrift/Drift";

/**
 * A form over the same options `.github/drift.yml` and the example
 * workflows accept, ending in a file a visitor can copy or download —
 * for teams who would rather pick from a list than read the full
 * configuration reference first.
 */
export default function Configure() {
  return (
    <div className="relative min-h-screen">
      <Backdrop />

      <header className="relative z-10 mx-auto flex max-w-[1600px] items-center gap-3 px-5 py-5 sm:px-10 lg:px-14">
        <Link href="/" className={`${instrumentSerif.className} text-2xl text-landing`}>
          Drift
        </Link>
        <nav className="ml-auto flex items-center gap-1 sm:gap-2">
          <Link
            href="/#action"
            className="hidden rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-surface-hover hover:text-foreground sm:block"
          >
            Action
          </Link>
          <a
            href={`${GITHUB}/blob/main/docs/configuration.md`}
            target="_blank"
            rel="noreferrer"
            className="hidden rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-surface-hover hover:text-foreground sm:block"
          >
            Full Config Reference
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
            <span className="text-faint">//</span> configure
          </p>
          <h1 className={`${instrumentSerif.className} mt-3 max-w-2xl text-3xl text-landing sm:text-4xl`}>
            Set up Drift without writing YAML
          </h1>
          <p className="mt-3 max-w-xl text-base leading-7 text-muted">
            The form starts with Drift&rsquo;s defaults. Change what your repository needs, then copy
            or download the files into <code className="font-mono text-[13px] text-brand-text">.github/</code>. The{" "}
            <a
              href={`${GITHUB}/blob/main/docs/configuration.md`}
              target="_blank"
              rel="noreferrer"
              className="text-brand-text underline decoration-dotted underline-offset-2"
            >
              configuration reference
            </a>{" "}
            covers the advanced options.
          </p>

          <ConfigureForm workflowTemplate={WORKFLOW_TEMPLATE} outdatedTemplate={OUTDATED_WORKFLOW_TEMPLATE} />
        </section>
      </main>

      <footer className="relative z-10 border-t border-border bg-background/60">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-2 px-5 py-6 text-xs text-faint sm:px-10 lg:px-14">
          <span className={`${instrumentSerif.className} text-base text-landing`}>Drift</span>
          <a href={GITHUB} target="_blank" rel="noreferrer" className="transition-colors hover:text-foreground">
            GitHub
          </a>
          <Link href="/" className="transition-colors hover:text-foreground">
            Home
          </Link>
        </div>
      </footer>
    </div>
  );
}
