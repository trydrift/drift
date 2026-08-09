import { instrumentSerif } from "@/lib/fonts";

/**
 * How a finding is actually made.
 *
 * The demo shows *that* Drift works; this shows *why* you should believe it.
 * Those are different jobs and the second one is where most tools wave: "we
 * analyse your dependencies" tells a developer nothing they can check. So this
 * section is specific to the point of being checkable — which file is read,
 * which endpoint is called, what happens when the call fails.
 *
 * Built from CSS and inline SVG rather than an image, so it stays legible at
 * any width, follows the theme, and can be read aloud. The layout is a vertical
 * spine on a phone and a wider grid on a desktop; nothing is duplicated between
 * the two, so there is one copy of every sentence and no `aria-hidden` twin.
 */

interface Stage {
  n: number;
  title: string;
  lead: string;
  detail: string;
  /** Concrete artefacts — the things a developer could go and open. */
  chips: string[];
}

const STAGES: Stage[] = [
  {
    n: 1,
    title: "Read what moved",
    lead: "Manifests and lockfiles, not guesses.",
    detail:
      "Drift parses the manifest with the same parser for every surface, then consults the lockfile to sharpen the installed version — a range says what is permitted, not what is on disk. Workspace members are read as separate packages, because a bump in one is a fact about that one.",
    chips: ["package.json", "go.mod", "Gemfile.lock", "pyproject.toml", "Cargo.toml", "pom.xml"],
  },
  {
    n: 2,
    title: "Gather evidence",
    lead: "Three independent sources, each with a link you can open.",
    detail:
      "Every record carries a URL or a local locator. This is the difference between Drift and asking a model what it remembers about a library.",
    chips: [],
  },
  {
    n: 3,
    title: "Decide what breaks",
    lead: "A finding without a citation is not a finding.",
    detail:
      "Computed diffs already know which symbol changed and how, so the analyser reads structure rather than re-parsing its own prose. Changelog lines go through explicit rules that recognise a removal or a rename and name the symbol. Every breaking change points back at the evidence that justified it, and anything that could not be established is recorded as a gap.",
    chips: ["removed-export", "signature-change", "renamed-export", "behaviour-change"],
  },
  {
    n: 4,
    title: "Find it in your code",
    lead: "Only the files that import it are searched.",
    detail:
      "The import graph is the precision lever: a file that never imports express cannot be broken by an express change, however often the word Router appears in it. Within those files Drift matches the symbols the evidence named — skipping comments and string literals, so a word in a docstring is never mistaken for a call. Each site gets its own confidence, highest when the file provably bound that symbol from that import.",
    chips: ["import graph", "AST-aligned index", "per-site confidence"],
  },
  {
    n: 5,
    title: "Plan, then fix",
    lead: "One commit per concern, in dependency order.",
    detail:
      "Drift never produces a single 'upgrade everything' commit — a reviewer has to be able to read, approve or revert one piece at a time, and git bisect has to stay meaningful. Each unit is resolved by a deterministic codemod where one exists, then a version-pinned community recipe, then an AI agent. Never silently, and always in that order.",
    chips: ["codemod", "community recipe", "AI agent", "reviewable PR"],
  },
];

/** The three evidence sources, which is the part people ask about. */
const SOURCES = [
  {
    title: "Registry metadata",
    what: "The package's own index entry",
    detail:
      "Deprecation notices, yanked releases, publish dates, the maintainer's own 'latest' tag, and known advisories from OSV for both the old version and the new one.",
    from: "registry.npmjs.org · pypi.org · crates.io · proxy.golang.org · rubygems.org",
  },
  {
    title: "Release notes & changelog",
    what: "What the maintainers said changed",
    detail:
      "Every GitHub release between the two versions, the repository's CHANGELOG, and any migration guide it points to. Read as prose, matched by explicit rules rather than by a model's recollection.",
    from: "GitHub Releases API · CHANGELOG.md · MIGRATION.md",
  },
  {
    title: "Computed API surface",
    what: "What actually changed, whatever they said",
    detail:
      "Both versions are fetched and their public surfaces compared symbol by symbol. This is the strongest signal Drift has, and the only one that catches a break nobody wrote down.",
    from: ".d.ts diff · go doc · rustdoc JSON · japicmp · Python stubs",
  },
];

export function Pipeline() {
  return (
    <section id="how" className="scroll-mt-8 pt-16 sm:pt-24">
      <h2 className={`${instrumentSerif.className} text-2xl text-landing sm:text-3xl`}>
        How a finding gets made
      </h2>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
        Five stages, each one independently checkable. Nothing reaches a report without a link a
        human can open.
      </p>

      <ol className="mt-8 space-y-3">
        {STAGES.map((stage, index) => (
          <li key={stage.n} className="relative">
            {/* The spine. Drawn behind the badge and stopped before the last
                stage, so the flow reads as connected without a line dangling
                off the end. */}
            {index < STAGES.length - 1 && (
              <span
                aria-hidden
                className="absolute left-[15px] top-9 bottom-[-0.75rem] w-px bg-gradient-to-b from-brand/45 to-border"
              />
            )}

            <div className="flex gap-4">
              <span className="relative z-10 mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-brand/35 bg-brand-soft font-mono text-xs font-semibold text-brand-text">
                {stage.n}
              </span>

              <div className="min-w-0 flex-1 rounded-2xl border border-border bg-surface/50 p-4 sm:p-5">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h3 className="text-sm font-semibold text-foreground">{stage.title}</h3>
                  <p className="text-[13px] text-brand-text">{stage.lead}</p>
                </div>
                <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-muted">
                  {stage.detail}
                </p>

                {stage.chips.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {stage.chips.map((chip) => (
                      <span
                        key={chip}
                        className="rounded-md border border-border bg-surface-hover px-1.5 py-0.5 font-mono text-[10px] text-faint"
                      >
                        {chip}
                      </span>
                    ))}
                  </div>
                )}

                {/* Stage 2 fans out, because "we gather evidence" is exactly the
                    sentence that needs breaking down. */}
                {stage.n === 2 && <EvidenceFan />}
              </div>
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-6 rounded-2xl border border-amber-500/25 bg-amber-500/[0.06] p-5">
        <h3 className="text-sm font-semibold text-amber-800 dark:text-amber-300">
          When a source cannot be reached
        </h3>
        <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-muted">
          It is recorded as a gap and the package is reported as{" "}
          <span className="font-medium text-foreground">not verified</span> — never as clean. Zero
          findings from a complete check and zero findings from a check that never happened are
          different facts, and a developer needs to be told which one they have. This is the whole
          reason the third verdict exists.
        </p>
      </div>
    </section>
  );
}

function EvidenceFan() {
  return (
    <div className="mt-4">
      {/* One input branching into three, drawn once and stretched to the grid
          below. `preserveAspectRatio="none"` is load-bearing: the branch points
          have to land on the centres of the three cards, at a sixth, a half and
          five sixths of the width, and the default letterboxing put all three
          in a huddle in the middle pointing at nothing. `non-scaling-stroke`
          keeps the line 1px wide after the horizontal stretch.

          Decorative — every label it points at is written below as text. */}
      <svg
        viewBox="0 0 300 32"
        preserveAspectRatio="none"
        className="hidden h-8 w-full text-brand/50 sm:block"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
        aria-hidden
      >
        <path d="M150 0 V14" vectorEffect="non-scaling-stroke" />
        <path d="M50 14 H250" vectorEffect="non-scaling-stroke" />
        <path d="M50 14 V32" vectorEffect="non-scaling-stroke" />
        <path d="M150 14 V32" vectorEffect="non-scaling-stroke" />
        <path d="M250 14 V32" vectorEffect="non-scaling-stroke" />
      </svg>

      <div className="grid gap-3 sm:grid-cols-3">
        {SOURCES.map((source) => (
          <div key={source.title} className="rounded-xl border border-border bg-surface p-3.5">
            <h4 className="text-[13px] font-semibold text-foreground">{source.title}</h4>
            <p className="mt-0.5 text-[11px] font-medium text-brand-text">{source.what}</p>
            <p className="mt-2 text-[12px] leading-relaxed text-muted">{source.detail}</p>
            <p className="mt-2.5 break-words font-mono text-[10px] leading-relaxed text-faint">
              {source.from}
            </p>
          </div>
        ))}
      </div>

      <p className="mt-3 text-[12px] leading-relaxed text-muted">
        Sources are independent on purpose. A maintainer who forgets to write a changelog entry is
        caught by the surface diff; a behaviour change with no signature change is caught by the
        changelog. Agreement between two raises confidence, and disagreement is reported rather than
        resolved by picking a favourite.
      </p>
    </div>
  );
}
