import { instrumentSerif } from "@/lib/fonts";
import { Code, GhBadge, GhCommit, GhIcon, GhPanel, type CodeLine } from "@/components/gh";
import { BYAM_LLM_REPAIR_STUDY } from "@/lib/external-citations";

/**
 * How a finding is actually made.
 *
 * The demo shows *that* Drift works; this shows *why* you should believe it.
 * Those are different jobs and the second one is where most tools wave: "we
 * analyse your dependencies" tells a developer nothing they can check. So this
 * section is specific to the point of being checkable — which file is read,
 * which endpoint is called, what happens when the call fails.
 *
 * Every stage carries the artefact it produces, drawn the way GitHub draws it:
 * a diff hunk, a surface comparison, an annotation, code-search results, a
 * commit list. Those artefacts, the explanatory paragraph, and the chips are
 * behind a native `<details>` per stage, closed by default — a reader gets the
 * five-stage flow and one short line per stage without scrolling past five
 * essays, and the real, checkable artefact is one click (or keystroke) away.
 *
 * One example runs through all five stages, and it is real: w3lib 2.1.1 →
 * 2.4.1 in Scrapy, taken from the recording on this same page
 * (`data/scrapy.json`). The release-note line, the four call sites, their
 * file paths and their line numbers are the recording's, unedited. Nothing
 * here is an illustration of what a finding might look like.
 *
 * Built from CSS and inline SVG rather than an image, so it stays legible at
 * any width, follows the theme, and can be read aloud.
 */

interface Stage {
  n: number;
  title: string;
  lead: string;
  detail: string;
  /** Concrete artefacts — the things a developer could go and open. */
  chips?: string[];
  artefact: React.ReactNode;
}

/* ── The worked example, from `data/scrapy.json` ───────────────────────── */

const MANIFEST_DIFF: CodeLine[] = [
  { text: "@@ pyproject.toml — [project.dependencies] @@", kind: "hunk" },
  { n: 25, text: '  "tldextract",' },
  { n: 26, text: '  "w3lib>=2.1.1",', kind: "del" },
  { n: 26, text: '  "w3lib>=2.4.1",', kind: "add" },
  { n: 27, text: '  "zope.interface>=5.1.0",' },
];

const CHANGE_EVIDENCE: CodeLine[] = [
  { text: "@@ w3lib v2.2.1 — release notes @@", kind: "hunk" },
  { text: "canonicalize_url() no longer applies lowercase" },
  { text: "to the userinfo URL component." },
];

/** The four sites, exactly as the recording lists them. */
const SITES: CodeLine[] = [
  {
    n: 57,
    text: "return canonicalize_url(link.url, keep_fragments=True)",
    kind: "hit",
    note: {
      tone: "found",
      label: "high confidence · 1 of 4 sites",
      body: (
        <>
          This file directly binds <code className="font-mono">canonicalize_url</code> from an
          import of w3lib, so the name here is provably that function — not a local one that
          shares its spelling. These are the four places that call the API whose behavior
          changed; whether a particular caller depends on lowercased userinfo is what the review
          step must determine.
        </>
      ),
    },
  },
  { n: 399, text: "link.url = canonicalize_url(link.url)", kind: "hit" },
  {
    n: 100,
    text: "url = canonicalize_url(request.url, keep_fragments=keep_fragments)",
    kind: "hit",
  },
  {
    n: 794,
    text: "return canonicalize_url(url, *args, **kwargs)",
    kind: "hit",
  },
];

const SITE_FILES = [
  "scrapy/linkextractors/lxmlhtml.py",
  "scrapy/linkextractors/lxmlhtml.py",
  "scrapy/utils/request.py",
  "tests/test_linkextractors.py",
];

const STAGES: Stage[] = [
  {
    n: 1,
    title: "Read What Moved",
    lead: "Manifests and lockfiles, not guesses.",
    detail:
      "Drift parses the manifest, then checks the lockfile for the version actually installed — a range only says what's permitted. Workspace members are read as separate packages, since a bump in one is a fact about that one.",
    chips: [
      "package.json",
      "go.mod",
      "Gemfile.lock",
      "pyproject.toml",
      "Cargo.toml",
      "pom.xml",
      "Directory.Packages.props",
      "conanfile.txt",
      "vcpkg.json",
      "platformio.ini",
    ],
    artefact: (
      <GhPanel icon="diff" name="pyproject.toml" meta="1 changed dependency">
        <Code lines={MANIFEST_DIFF} />
      </GhPanel>
    ),
  },
  {
    n: 2,
    title: "Gather Evidence",
    lead: "Three independent sources, each with a link you can open.",
    detail:
      "Every record carries a URL or a local locator — the difference between Drift and asking a model what it remembers about a library.",
    artefact: <EvidenceFan />,
  },
  {
    n: 3,
    title: "Decide What Breaks",
    lead: "A finding without a citation is not a finding.",
    detail:
      "Computed diffs already know which symbol changed and how, so Drift reads structure rather than prose. Changelog lines go through rules that recognize a removal or a rename. Every breaking change points back at the evidence that justified it, and anything it couldn't establish is recorded as a gap.",
    artefact: <FindingCard />,
  },
  {
    n: 4,
    title: "Find It in Your Code",
    lead: "Only the files that import it are searched.",
    detail:
      "A file that never imports w3lib can't be broken by a w3lib change, however often the word url appears in it. Within files that do, Drift matches the symbols the evidence named — skipping comments and strings, so a word in a docstring is never mistaken for a call. Each site gets its own confidence, highest when the file provably bound that symbol from that import.",
    chips: ["import graph", "#include graph", "AST-aligned index", "per-site confidence"],
    artefact: (
      <GhPanel icon="search" name="symbol: canonicalize_url" meta="4 results · 3 files">
        <div className="divide-y divide-border">
          {SITES.map((site, index) => (
            <div key={SITE_FILES[index]}>
              <p className="flex items-center gap-1.5 bg-surface px-3 py-1.5 font-mono text-[11px] text-faint">
                <GhIcon icon="file" className="size-3" />
                {SITE_FILES[index]}
              </p>
              <Code lines={[site]} />
            </div>
          ))}
        </div>
      </GhPanel>
    ),
  },
  {
    n: 5,
    title: "Plan, Then Fix",
    lead: "One commit per concern, in dependency order.",
    detail:
      "Never one 'upgrade everything' commit — a reviewer has to read, approve, or revert one piece at a time, and git bisect has to stay meaningful. Each change is resolved by a deterministic codemod where one exists, then a validated fix plan — one rule, applied to every call site at once — then an AI agent for whatever is left. Never silently, and always in that order.",
    artefact: (
      <GhPanel icon="commit" name="drift/upgrade-w3lib" meta="2 commits">
        <div className="divide-y divide-border">
          <GhCommit
            tag="dependency"
            message="deps: w3lib 2.1.1 → 2.4.1"
            detail="The dependency move is isolated so it can be reviewed or reverted independently."
          />
          <GhCommit
            tag="agent"
            message="review(w3lib): verify canonicalize_url userinfo semantics"
            detail="The upstream change is behavioral, not syntactic. Review the four directly bound canonicalize_url call sites and only change code where it actually relies on userinfo being lowercased. If no caller relies on that behavior, no source edit is needed."
          />
        </div>
      </GhPanel>
    ),
  },
];

/** The three evidence sources, which is the part people ask about. */
const SOURCES = [
  {
    title: "Registry metadata",
    what: "The package's own index entry",
    detail:
      "Deprecation notices, yanked releases, publish dates, the maintainer's own 'latest' tag, and known advisories from OSV for both versions.",
    lines: ["GET pypi.org/pypi/w3lib/json", "GET api.osv.dev/v1/query  ← both versions"],
  },
  {
    title: "Release notes & changelog",
    what: "What the maintainers said changed",
    detail:
      "Every GitHub release between the two versions, the CHANGELOG, and any migration guide it points to — matched by explicit rules, not a model's recollection.",
    lines: ["GET api.github.com/repos/scrapy/w3lib/releases", "GET raw…/w3lib/master/CHANGELOG.rst"],
  },
  {
    title: "Computed API surface",
    what: "What actually changed, whatever they said",
    detail:
      "Both versions are fetched and their public surfaces compared symbol by symbol — nothing is installed, no build script runs. Drift's strongest signal, and the only one that catches a break nobody wrote down.",
    lines: [".d.ts · Go AST · rustdoc JSON", "japicmp · ECMA-335 · C headers · stubs"],
  },
];

/**
 * The rules that produce silence.
 *
 * Kept concrete on purpose: "we filter out noise" is unfalsifiable, and a
 * developer deciding whether to trust a report needs to know the actual
 * boundary. Each of these was a real wrong answer first — so each is shown as
 * the line that produced it, with the comment Drift declines to leave.
 */
const SILENCES = [
  {
    file: "scrapy/core/downloader/tls.py",
    code: "from twisted.internet.ssl import Certificate",
    what: "A symbol this file got from somewhere else.",
    why: "Certificate here is Twisted's, whatever cryptography did to a class of the same name. A name has one binding in a scope, and the import says whose it is.",
  },
  {
    file: "components/ui/button.tsx",
    code: 'const Comp = asChild ? Slot : "button";',
    what: "A mention, when the change is a change of signature.",
    why: "A changed argument list is a fact about calls. Storing the name, re-exporting it, or asking for its type passes no arguments and has nothing to update.",
  },
  {
    file: "scrapy/utils/conf.py",
    code: '    """To define format set a colon at the end of the o…"""',
    what: "A word inside a comment, a docstring, or a string.",
    why: "An English sentence containing the word define is not a call to define. Comments are stripped and string contents blanked before any identifier is matched.",
  },
  {
    file: "w3lib/url.py",
    code: "+ def add_or_replace_parameters(url, new_parameters)",
    what: "Anything additive.",
    why: "A new export, a widened parameter, a new optional field. It cannot break a caller, so it appears in the reasons to upgrade and never in the risks.",
  },
  {
    file: "openapi.yaml",
    code: "+ responses.200.content.schema.properties.region",
    what: "Changes that break the server, not you.",
    why: "In an API diff only the consumer-breaking direction is reported. A response gaining a field is not your problem, and a report you have to filter is a report nobody reads twice.",
  },
  {
    file: "zlib.h",
    code: '#define ZLIB_VERSION "1.3.1"',
    what: "A version constant that moves every release.",
    why: "ZLIB_VERSION changes on every single tag. A guaranteed finding at the top of every upgrade teaches people to skim past the ones that matter.",
  },
] as const;

const CONFIDENCE = [
  {
    label: "High",
    detail:
      "The file bound that exact symbol from an import of this dependency. There is an edge from the declaration to this line.",
  },
  {
    label: "Medium",
    detail:
      "The file imports the dependency and the symbol appears in it. Also the ceiling for C and C++, where #include binds no names and only a compiler could say more.",
  },
  {
    label: "Low",
    detail:
      "The symbol appears but no import link could be established — a dynamic import, a re-export barrel, or a package whose module name differs from its own.",
  },
] as const;

/** The default-visible flow — five words, no prose, before any disclosure. */
const FLOW = [
  { label: "Dependency moved", caption: "manifest + lockfile" },
  { label: "API changed", caption: "release notes + API diff" },
  { label: "Your code uses it", caption: "imports + exact call sites" },
  { label: "Verify", caption: "build / test" },
  { label: "Fix", caption: "codemod → fix plan → agent" },
] as const;

export function Pipeline() {
  return (
    <section id="how" className="scroll-mt-8 pt-16 sm:pt-24">
      <h2 className={`${instrumentSerif.className} text-2xl text-landing sm:text-3xl`}>
        How a Finding Gets Made
      </h2>

      {/* The whole pipeline, in five words. Nothing below this needs to be
          read for a visitor to understand the shape of what Drift does —
          everything past here is progressive disclosure for whoever wants
          the checkable detail. */}
      <ol className="mt-5 flex flex-wrap items-center gap-x-1.5 gap-y-3 font-mono text-[11px]">
        {FLOW.map((step, index) => (
          <li key={step.label} className="flex items-center gap-1.5">
            <span className="flex flex-col items-start rounded-lg border border-border bg-surface/70 px-2.5 py-1.5">
              <span className="text-[12px] font-medium text-foreground">{step.label}</span>
              <span className="text-faint">{step.caption}</span>
            </span>
            {index < FLOW.length - 1 && (
              <span className="text-faint" aria-hidden>
                →
              </span>
            )}
          </li>
        ))}
      </ol>

      <p className="mt-4 max-w-2xl text-[13px] leading-relaxed text-muted">
        Real example: <code className="font-mono text-brand-text">w3lib</code> 2.1.1 → 2.4.1 in
        Scrapy, from the recording above. Each stage below opens to the artefact it actually
        produced.
      </p>

      <ol className="mt-6 space-y-2">
        {STAGES.map((stage, index) => (
          <li key={stage.n} className="relative">
            {index < STAGES.length - 1 && (
              <span
                aria-hidden
                className="absolute left-3.75 top-9 -bottom-2 w-px bg-linear-to-b from-brand/45 to-border"
              />
            )}

            <div className="flex gap-4">
              <span className="relative z-10 mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-brand/35 bg-brand-soft font-mono text-xs font-semibold text-brand-text">
                {stage.n}
              </span>

              <details className="group min-w-0 flex-1 rounded-2xl border border-border bg-surface/50 open:pb-4 sm:open:pb-5">
                <summary className="flex cursor-pointer list-none items-center gap-3 p-4 sm:p-5 [&::-webkit-details-marker]:hidden">
                  <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="text-sm font-semibold text-foreground">{stage.title}</span>
                    <span className="text-[13px] text-brand-text">{stage.lead}</span>
                  </span>
                  <ChevronIcon className="size-4 shrink-0 text-faint transition-transform group-open:rotate-180" />
                </summary>

                <div className="grid gap-4 px-4 sm:px-5 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:items-start">
                  <div className="min-w-0">
                    <p className="text-[13px] leading-relaxed text-muted">{stage.detail}</p>
                    {stage.n === 5 && (
                      <p className="mt-2 text-[12px] leading-relaxed text-muted">
                        Structured context like this measurably helps automated repair — the
                        strongest tested model in a peer-reviewed study{" "}
                        <a
                          href={BYAM_LLM_REPAIR_STUDY.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-brand-text underline decoration-dotted underline-offset-2"
                          title={BYAM_LLM_REPAIR_STUDY.scope}
                        >
                          fully repaired {BYAM_LLM_REPAIR_STUDY.buildRepairRate} of breaking builds
                        </a>{" "}
                        when given the erroneous line and the API diff.
                      </p>
                    )}

                    {stage.chips && (
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
                  </div>

                  {/* Stage 2's artefact is three panels wide, so it takes the
                      whole row rather than being squeezed into one column. */}
                  <div className={stage.n === 2 ? "min-w-0 lg:col-span-2" : "min-w-0"}>
                    {stage.artefact}
                  </div>
                </div>
              </details>
            </div>
          </li>
        ))}
      </ol>

      {/* Verification rules and confidence — real detail, kept out of the
          default scroll behind one disclosure rather than three separate
          always-open cards. */}
      <details className="group mt-4 rounded-2xl border border-border bg-surface/50">
        <summary className="flex cursor-pointer list-none items-center gap-3 p-4 sm:p-5 [&::-webkit-details-marker]:hidden">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
            Verification rules &amp; confidence
          </span>
          <span className="hidden min-w-0 shrink text-right text-[12px] text-muted md:block md:truncate">
            what counts as a gap, six silenced patterns, three confidence levels
          </span>
          <ChevronIcon className="size-4 shrink-0 text-faint transition-transform group-open:rotate-180" />
        </summary>

        <div className="px-4 pb-5 sm:px-5">
          <div className="grid gap-4 lg:grid-cols-[0.85fr_1.15fr] lg:items-start">
            <div className="min-w-0 rounded-2xl border border-amber-500/25 bg-amber-500/6 p-5">
              <h3 className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                When a Source Can&rsquo;t Be Reached
              </h3>
              <p className="mt-2 text-[13px] leading-relaxed text-muted">
                It&rsquo;s recorded as a gap and the package is reported as{" "}
                <span className="font-medium text-foreground">not verified</span> — never as clean.
                Zero findings from a complete check and zero findings from a check that never ran
                are different facts, and you need to know which one you have.
              </p>
              <div className="mt-4 overflow-hidden rounded-xl border border-border bg-surface">
                <div className="flex items-center gap-2 border-b border-border bg-surface-hover/50 px-3 py-2">
                  <span className="size-2 rounded-full bg-amber-500" />
                  <span className="font-mono text-[11px] text-foreground">not verified</span>
                </div>
                <p className="px-3 py-2.5 font-mono text-[11px] leading-relaxed text-muted">
                  Drift found nothing it could check this version against.
                </p>
              </div>
            </div>

            {/* The other half of trust. A tool is judged as much on what it
                stays quiet about as on what it finds, and "we filter noise" is
                not a claim anyone can check — so these are the actual rules,
                each one shown as the line that would have been reported
                without it. */}
            <div className="min-w-0 rounded-2xl border border-border bg-surface/50 p-5">
              <h3 className="text-sm font-semibold text-foreground">What Drift Refuses to Report</h3>
              <p className="mt-2 text-[13px] leading-relaxed text-muted">
                Six lines that match a changed symbol and get no comment — each rule exists because
                a real run got it wrong without it.
              </p>

              <div className="mt-4 overflow-hidden rounded-xl border border-border bg-surface">
                {SILENCES.map((rule, index) => (
                  <div key={rule.what} className={index > 0 ? "border-t border-border" : undefined}>
                    <p className="flex items-center gap-1.5 bg-surface-hover/40 px-3 py-1.5 font-mono text-[10.5px] text-faint">
                      <GhIcon icon="file" className="size-3 shrink-0" />
                      <span className="min-w-0 truncate">{rule.file}</span>
                      <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wider">
                        no comment
                      </span>
                    </p>
                    <div className="overflow-x-auto bg-(--pre-bg) px-3 py-1.5">
                      <code className="whitespace-pre font-mono text-[11.5px] text-muted/80 line-through decoration-faint/50">
                        {rule.code}
                      </code>
                    </div>
                    <p className="px-3 py-2 text-[12px] leading-relaxed text-muted">
                      <span className="font-medium text-foreground">{rule.what}</span> {rule.why}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-4 rounded-2xl border border-border bg-surface/50 p-5">
            <h3 className="text-sm font-semibold text-foreground">
              What the Confidence on a Finding Means
            </h3>
            <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-muted">
              Two separate questions underneath.{" "}
              <em className="not-italic text-foreground">Did this happen upstream?</em> is answered
              by the evidence — a computed diff starts high, prose starts medium, and agreement
              between sources promotes it. <em className="not-italic text-foreground">Does it land
              here?</em> is answered per line. Drift keeps them apart internally — a certain
              upstream diff is not a reason to call a repository affected on its own — but rolls
              them into one score on the report, so the question &ldquo;how sure is Drift,
              overall?&rdquo; has a plain answer without hiding the breakdown that produced it.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              {CONFIDENCE.map((level) => (
                <div key={level.label} className="rounded-xl border border-border bg-surface p-3.5">
                  <p className="font-mono text-[11px] font-semibold uppercase tracking-wider text-brand-text">
                    {level.label}
                  </p>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-muted">{level.detail}</p>
                </div>
              ))}
            </div>
            <p className="mt-3 max-w-3xl text-[12px] leading-relaxed text-muted">
              AI-pass findings are capped at medium by construction, so they can never alone clear
              the bar to open a pull request. They assist recall — they don&rsquo;t get a vote.
            </p>
            <p className="mt-3 max-w-3xl text-[12px] leading-relaxed text-muted">
              And when Drift isn&rsquo;t sure a change lands in your code, it says so in the verdict
              itself — <span className="font-medium text-foreground">&ldquo;may affect your
              code&rdquo;</span>, not <span className="font-medium text-foreground">&ldquo;affects
              your code&rdquo;</span>, for anything short of a directly imported match. Being wrong
              with the same confidence as being right is the failure mode this whole model exists
              to avoid.
            </p>
          </div>
        </div>
      </details>
    </section>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path
        d="m6 9 6 6 6-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The finding itself, drawn as the check annotation it becomes.
 *
 * Every field is from `data/scrapy.json`: the kind, the confidence, the
 * summary, and the release-note line the remediation quotes verbatim.
 */
function FindingCard() {
  return (
    <GhPanel icon="check" name="drift / analyze" meta="w3lib · 6 breaking changes">
      <div className="border-b border-border px-3 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <GhBadge tone="warn">behaviour-change</GhBadge>
          <GhBadge tone="brand">confidence: 60/100 — Fairly confident</GhBadge>
          <GhBadge>cites: GitHub release notes</GhBadge>
        </div>
        <p className="mt-2.5 text-[13px] font-medium text-foreground">
          <code className="font-mono">canonicalize_url</code> no longer applies lowercase to the
          userinfo URL component.
        </p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
          Review call sites for assumptions that no longer hold. Make any dependency on
          lowercased userinfo explicit instead of silently relying on the previous
          canonicalization behavior.
        </p>
      </div>
      <Code lines={CHANGE_EVIDENCE} />
    </GhPanel>
  );
}

function EvidenceFan() {
  return (
    <div>
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
          <div
            key={source.title}
            className="flex flex-col overflow-hidden rounded-xl border border-border bg-surface"
          >
            <div className="flex-1 p-3.5">
              <h4 className="text-[13px] font-semibold text-foreground">{source.title}</h4>
              <p className="mt-0.5 text-[11px] font-medium text-brand-text">{source.what}</p>
              <p className="mt-2 text-[12px] leading-relaxed text-muted">{source.detail}</p>
            </div>
            <div className="border-t border-border bg-(--pre-bg) px-3 py-2">
              {source.lines.map((line) => (
                <p
                  key={line}
                  className="truncate font-mono text-[10px] leading-relaxed text-faint"
                  title={line}
                >
                  {line}
                </p>
              ))}
            </div>
          </div>
        ))}
      </div>

      <p className="mt-3 text-[12px] leading-relaxed text-muted">
        Sources are independent on purpose. A missing changelog entry is caught by the surface
        diff; a behavior change with no signature change is caught by the changelog. Agreement
        raises confidence, and disagreement is reported rather than resolved by picking a favorite.
      </p>
    </div>
  );
}
