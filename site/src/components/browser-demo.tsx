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
 * Drawn as a row of chips rather than sixteen cards. The card grid gave every
 * ecosystem a headline, a package and a version pair, which is a lot of surface
 * for a decision the reader makes in one glance — they are looking for their own
 * language and ignoring the other fifteen. A chip answers that question in the
 * width of a word, and the upgrade each one runs is still there on hover and for
 * a screen reader, where it informs without competing.
 */
export function BrowserDemo() {
  return (
    <div>
      <ul className="flex flex-wrap gap-2">
        {DEMOS.map((demo) => (
          <li key={demo.ecosystem}>
            <a
              href={codespaceUrl(demo.ecosystem)}
              target="_blank"
              rel="noreferrer"
              // The upgrade is the tooltip and the accessible name, so the chip
              // stays one word wide without hiding what it actually runs.
              title={`${labelFor(demo.ecosystem)} — ${upgradeLabel(demo)}`}
              className="group flex items-center gap-2 rounded-full border border-border bg-surface/75 py-1.5 pl-3 pr-2.5 text-[13px] text-foreground transition-colors hover:border-brand hover:bg-surface-hover"
            >
              <span>{labelFor(demo.ecosystem)}</span>
              <span className="font-mono text-[10px] text-faint transition-colors group-hover:text-brand-text">
                {demo.ecosystem}
              </span>
              <span className="sr-only">— {upgradeLabel(demo)}, opens a Codespace</span>
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
      <p className="mt-5 max-w-2xl text-[11px] leading-relaxed text-faint">
        Opens a GitHub Codespace on your own account — nothing to install, and the free tier covers it. The
        extension and the <code className="font-mono">drift</code> CLI are both already set up: the panel analyses
        the change as the editor opens, and the terminal runs{" "}
        <code className="font-mono">drift analyze</code> next to it.
      </p>
    </div>
  );
}
