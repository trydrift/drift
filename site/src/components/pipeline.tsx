import { instrumentSerif } from "@/lib/fonts";
import { Code, GhBadge, GhCommit, GhIcon, GhPanel, type CodeLine } from "@/components/gh";

/**
 * How a finding is actually made.
 *
 * The demo shows *that* Drift works; this shows *why* you should believe it.
 * Those are different jobs and the second one is where most tools wave: "we
 * analyse your dependencies" tells a developer nothing they can check. So this
 * section is specific to the point of being checkable — which file is read,
 * which endpoint is called, what happens when the call fails.
 *
 * Every stage now carries the artefact it produces, drawn the way GitHub draws
 * it: a diff hunk, a surface comparison, an annotation, code-search results, a
 * commit list. The previous version described those artefacts in prose inside
 * rounded cards, which asked a reader to imagine the output of a tool whose
 * entire value is that the output is concrete.
 *
 * One example runs through all five stages, and it is real: w3lib 1.17.0 →
 * 2.4.1 in Scrapy, taken from the recording on this same page
 * (`data/scrapy.json`). The signature line, the four call sites, their file
 * paths and their line numbers are the recording's, unedited. Nothing here is
 * an illustration of what a finding might look like.
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
  { n: 41, text: '  "cssselect>=0.9.1",' },
  { n: 42, text: '  "itemloaders>=1.0.1",' },
  { n: 43, text: '  "w3lib>=1.17.0",', kind: "del" },
  { n: 43, text: '  "w3lib>=2.4.1",', kind: "add" },
  { n: 44, text: '  "parsel>=1.5.0",' },
];

const SURFACE_DIFF: CodeLine[] = [
  { text: "@@ w3lib.url — public surface · defaults 2 → 3 @@", kind: "hunk" },
  { text: "def safe_url_string(url, encoding, path_encoding)", kind: "del" },
  { text: "def safe_url_string(url, encoding, path_encoding, quote_path)", kind: "add" },
];

/** The four sites, exactly as the recording lists them. */
const SITES: CodeLine[] = [
  {
    n: 224,
    text: 'location = safe_url_string(response.headers["Location"])',
    kind: "hit",
  },
  { n: 269, text: "self._url = safe_url_string(url, self.encoding)", kind: "hit" },
  {
    n: 138,
    text: "url = safe_url_string(url, encoding=response_encoding)",
    kind: "hit",
    note: {
      tone: "found",
      label: "high confidence · 1 of 25 sites",
      body: (
        <>
          This file binds <code className="font-mono">safe_url_string</code> from an import of
          w3lib, so the name here is provably that function — not a local one that shares its
          spelling.
        </>
      ),
    },
  },
  {
    n: 196,
    text: 'safe_url_string("http://EXAMPLE.ORG/SOMEPAGE/ITEM/12.HTML"),',
    kind: "hit",
  },
];

const SITE_FILES = [
  "scrapy/downloadermiddlewares/redirect.py",
  "scrapy/http/request/__init__.py",
  "scrapy/linkextractors/lxmlhtml.py",
  "tests/test_spider_crawl.py",
];

const STAGES: Stage[] = [
  {
    n: 1,
    title: "Read what moved",
    lead: "Manifests and lockfiles, not guesses.",
    detail:
      "Drift parses the manifest with the same parser for every surface, then consults the lockfile to sharpen the installed version — a range says what is permitted, not what is on disk. Workspace members are read as separate packages, because a bump in one is a fact about that one.",
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
    title: "Gather evidence",
    lead: "Three independent sources, each with a link you can open.",
    detail:
      "Every record carries a URL or a local locator. This is the difference between Drift and asking a model what it remembers about a library.",
    artefact: <EvidenceFan />,
  },
  {
    n: 3,
    title: "Decide what breaks",
    lead: "A finding without a citation is not a finding.",
    detail:
      "Computed diffs already know which symbol changed and how, so the analyser reads structure rather than re-parsing its own prose. Changelog lines go through explicit rules that recognise a removal or a rename and name the symbol. Every breaking change points back at the evidence that justified it, and anything that could not be established is recorded as a gap.",
    artefact: <FindingCard />,
  },
  {
    n: 4,
    title: "Find it in your code",
    lead: "Only the files that import it are searched.",
    detail:
      "The import graph is the precision lever: a file that never imports w3lib cannot be broken by a w3lib change, however often the word url appears in it. Within those files Drift matches the symbols the evidence named — skipping comments and string literals, so a word in a docstring is never mistaken for a call. Each site gets its own confidence, highest when the file provably bound that symbol from that import.",
    chips: ["import graph", "#include graph", "AST-aligned index", "per-site confidence"],
    artefact: (
      <GhPanel icon="search" name="symbol: safe_url_string" meta="25 results · 10 files">
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
    title: "Plan, then fix",
    lead: "One commit per concern, in dependency order.",
    detail:
      "Drift never produces a single 'upgrade everything' commit — a reviewer has to be able to read, approve or revert one piece at a time, and git bisect has to stay meaningful. Each unit is resolved by a deterministic codemod where one exists, then a version-pinned community recipe, then an AI agent. Never silently, and always in that order.",
    artefact: (
      <GhPanel icon="commit" name="drift/upgrade-w3lib" meta="3 commits">
        <div className="divide-y divide-border">
          <GhCommit
            tag="codemod"
            message="deps: w3lib 1.17.0 → 2.4.1"
            detail="The manifest and the lockfile, alone, so the version move is revertible on its own."
          />
          <GhCommit
            tag="recipe"
            message="fix(w3lib): pass quote_path explicitly at 25 call sites"
            detail="A version-pinned community recipe for the signature change, applied deterministically."
          />
          <GhCommit
            tag="agent"
            message="fix(w3lib): canonicalize_url no longer lowercases userinfo"
            detail="A behaviour change has no mechanical fix, so it is dispatched last and reviewed as its own commit."
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
      "Deprecation notices, yanked releases, publish dates, the maintainer's own 'latest' tag, and known advisories from OSV for both the old version and the new one.",
    lines: ["GET pypi.org/pypi/w3lib/json", "GET api.osv.dev/v1/query  ← both versions"],
  },
  {
    title: "Release notes & changelog",
    what: "What the maintainers said changed",
    detail:
      "Every GitHub release between the two versions, the repository's CHANGELOG, and any migration guide it points to. Read as prose, matched by explicit rules rather than by a model's recollection.",
    lines: ["GET api.github.com/repos/scrapy/w3lib/releases", "GET raw…/w3lib/master/CHANGELOG.rst"],
  },
  {
    title: "Computed API surface",
    what: "What actually changed, whatever they said",
    detail:
      "Both versions are fetched and their public surfaces compared symbol by symbol — nothing is installed and no build script of theirs is ever run. This is the strongest signal Drift has, and the only one that catches a break nobody wrote down.",
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

export function Pipeline() {
  return (
    <section id="how" className="scroll-mt-8 pt-16 sm:pt-24">
      <h2 className={`${instrumentSerif.className} text-2xl text-landing sm:text-3xl`}>
        How a finding gets made
      </h2>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
        Five stages, each one independently checkable — followed here by the artefact it produces.
        The example is a real one: <code className="font-mono text-[13px] text-brand-text">w3lib</code>{" "}
        1.17.0 → 2.4.1 in Scrapy, from the recording above. And the rules that keep Drift{" "}
        <em className="not-italic text-foreground">quiet</em> are written out below the pipeline,
        because those are the ones you cannot verify by reading a finding.
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
                className="absolute left-3.75 top-9 -bottom-3 w-px bg-linear-to-b from-brand/45 to-border"
              />
            )}

            <div className="flex gap-4">
              <span className="relative z-10 mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-brand/35 bg-brand-soft font-mono text-xs font-semibold text-brand-text">
                {stage.n}
              </span>

              <div className="min-w-0 flex-1 rounded-2xl border border-border bg-surface/50 p-4 sm:p-5">
                <div className="grid gap-4 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:items-start">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <h3 className="text-sm font-semibold text-foreground">{stage.title}</h3>
                      <p className="text-[13px] text-brand-text">{stage.lead}</p>
                    </div>
                    <p className="mt-2 text-[13px] leading-relaxed text-muted">{stage.detail}</p>

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
              </div>
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-6 grid gap-4 lg:grid-cols-[0.85fr_1.15fr] lg:items-start">
        <div className="min-w-0 rounded-2xl border border-amber-500/25 bg-amber-500/6 p-5">
          <h3 className="text-sm font-semibold text-amber-800 dark:text-amber-300">
            When a source cannot be reached
          </h3>
          <p className="mt-2 text-[13px] leading-relaxed text-muted">
            It is recorded as a gap and the package is reported as{" "}
            <span className="font-medium text-foreground">not verified</span> — never as clean. Zero
            findings from a complete check and zero findings from a check that never happened are
            different facts, and a developer needs to be told which one they have. This is the whole
            reason the third verdict exists.
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

        {/* The other half of trust. A tool is judged as much on what it stays
            quiet about as on what it finds, and "we filter noise" is not a
            claim anyone can check — so these are the actual rules, each one
            shown as the line that would have been reported without it. */}
        <div className="min-w-0 rounded-2xl border border-border bg-surface/50 p-5">
          <h3 className="text-sm font-semibold text-foreground">What Drift refuses to report</h3>
          <p className="mt-2 text-[13px] leading-relaxed text-muted">
            Six lines that match a changed symbol and get no comment. Every rule below exists
            because a real run produced the wrong answer without it.
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
          What the confidence on a finding means
        </h3>
        <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-muted">
          Two separate questions, never merged into one number. <em className="not-italic text-foreground">Did
          this change happen upstream?</em> is answered by the evidence — a computed surface diff
          starts high, prose starts medium, and two independent sources agreeing promotes it.{" "}
          <em className="not-italic text-foreground">Does it land here?</em> is answered per line.
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
          A finding produced by the optional AI pass is capped at medium by construction, so it can
          never on its own clear the bar to open a pull request. It assists recall; it does not get
          a vote.
        </p>
      </div>
    </section>
  );
}

/**
 * The finding itself, drawn as the check annotation it becomes.
 *
 * Every field is from `data/scrapy.json`: the kind, the confidence, the
 * summary, and the before/after signature the remediation quotes verbatim.
 */
function FindingCard() {
  return (
    <GhPanel icon="check" name="drift / analyze" meta="w3lib · 13 breaking changes">
      <div className="border-b border-border px-3 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <GhBadge tone="warn">signature-change</GhBadge>
          <GhBadge tone="brand">confidence: high</GhBadge>
          <GhBadge>cites: computed surface diff</GhBadge>
        </div>
        <p className="mt-2.5 text-[13px] font-medium text-foreground">
          The signature of <code className="font-mono">url.safe_url_string</code> changed.
        </p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
          Update every call site to match the new signature exactly. Pay attention to argument
          order, argument count, and whether an options object replaced positional arguments.
        </p>
      </div>
      <Code lines={SURFACE_DIFF} />
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
        Sources are independent on purpose. A maintainer who forgets to write a changelog entry is
        caught by the surface diff; a behaviour change with no signature change is caught by the
        changelog. Agreement between two raises confidence, and disagreement is reported rather than
        resolved by picking a favourite.
      </p>
    </div>
  );
}
