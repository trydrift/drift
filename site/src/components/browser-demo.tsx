import { DEMOS, codespaceUrl, labelFor, upgradeLabel } from "@/lib/demos";

/**
 * "Try it in your browser" — a Codespace for every ecosystem Drift supports.
 *
 * Every other proof on this page is something the reader watches: a recording,
 * a benchmark number, a support matrix. This is the one they can run, on a real
 * repository, against a real upgrade, in a real editor — which is the only
 * answer to the reasonable suspicion that a recorded demo was chosen because it
 * worked.
 *
 * The fixture is honest about what it is. Each demo repository is committed at
 * the *old* dependency version with source that was correct for it, and
 * Codespace creation edits the manifest to the new version and touches nothing
 * else. So Drift is handed an ordinary uncommitted dependency change — the
 * exact situation a developer is in mid-upgrade — and nothing in Drift knows it
 * is a demo. `git status` in the Codespace shows one modified manifest, which
 * is the claim, checkable in the demo itself.
 *
 * Sixteen links rather than one, because the first question a visitor has is
 * "does it do *my* language", and answering it with a JavaScript demo and a
 * promise about the rest is how the support table lost trust before.
 */
export function BrowserDemo() {
  return (
    <div>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {DEMOS.map((demo) => (
          <li key={demo.ecosystem}>
            <a
              href={codespaceUrl(demo.ecosystem)}
              target="_blank"
              rel="noreferrer"
              className="group flex h-full flex-col rounded-lg border border-border bg-surface/75 px-4 py-3 transition-colors hover:bg-surface-hover"
            >
              <span className="flex items-baseline justify-between gap-2">
                <span className="text-[13px] font-medium text-foreground">{labelFor(demo.ecosystem)}</span>
                <span className="shrink-0 font-mono text-[11px] text-faint">{demo.ecosystem}</span>
              </span>
              {/*
                The upgrade, not a tagline: the package and the two versions are
                what tell a reader whether this is a toy or a real break.
              */}
              <span className="mt-1.5 break-words font-mono text-[11px] leading-snug text-muted">
                {upgradeLabel(demo)}
              </span>
              <span className="mt-2.5 text-[11px] uppercase tracking-[0.14em] text-faint group-hover:text-brand-text">
                Open in a Codespace →
              </span>
            </a>
          </li>
        ))}
      </ul>

      {/*
        Said plainly rather than in a footnote. A Codespace is created under the
        visitor's own GitHub account and spends their own free allowance, and
        finding that out on GitHub's create page instead of here would be a
        worse experience than being told.
      */}
      <p className="mt-5 text-[11px] leading-relaxed text-faint">
        Opens a GitHub Codespace on your own account — nothing to install, and the free tier covers it. The
        extension and the <code className="font-mono">drift</code> CLI are both already set up: the panel analyses
        the change as the editor opens, and the terminal runs{" "}
        <code className="font-mono">drift analyze</code> next to it.
      </p>
    </div>
  );
}
