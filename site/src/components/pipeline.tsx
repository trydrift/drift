import { instrumentSerif } from "@/lib/fonts";

const FLOW = [
  {
    title: "Drift sees the dependency update",
    detail: "It reads the version change from your manifest and lockfile.",
  },
  {
    title: "It checks what changed upstream",
    detail: "Release notes and API diffs show which exported APIs changed or disappeared.",
  },
  {
    title: "It checks whether your code uses them",
    detail: "Drift follows imports and points to the exact files and lines that are affected.",
  },
] as const;

export function Pipeline() {
  return (
    <section id="how" className="scroll-mt-8 pt-16 sm:pt-24">
      <h2 className={`${instrumentSerif.className} text-2xl text-landing sm:text-3xl`}>
        How findings work
      </h2>
      <p className="mt-3 max-w-2xl text-[14px] leading-relaxed text-muted">
        Drift finds code that may break when you upgrade a dependency. Each finding tells you what
        changed, where your code uses it, and the evidence behind it.
      </p>

      <ol className="mt-6 grid gap-3 md:grid-cols-3">
        {FLOW.map((step, index) => (
          <li key={step.title} className="rounded-xl border border-border bg-surface/60 p-4">
            <p className="font-mono text-[11px] text-faint">0{index + 1}</p>
            <h3 className="mt-2 text-sm font-semibold text-foreground">{step.title}</h3>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{step.detail}</p>
          </li>
        ))}
      </ol>

      <div className="mt-5 overflow-hidden rounded-xl border border-border bg-surface/70">
        <div className="border-b border-border px-4 py-3">
          <p className="font-mono text-[11px] text-faint">Example finding</p>
          <p className="mt-1 text-sm font-semibold text-foreground">
            w3lib changed <code className="font-mono">safe_url_string</code>
          </p>
        </div>
        <div className="grid gap-px bg-border md:grid-cols-3">
          <div className="bg-surface px-4 py-3">
            <p className="text-[11px] uppercase tracking-[0.12em] text-faint">What changed</p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
              The function signature changed between the installed and target versions.
            </p>
          </div>
          <div className="bg-surface px-4 py-3">
            <p className="text-[11px] uppercase tracking-[0.12em] text-faint">Where it matters</p>
            <p className="mt-1.5 font-mono text-[12px] leading-relaxed text-foreground">
              scrapy/linkextractors/lxmlhtml.py:138
            </p>
          </div>
          <div className="bg-surface px-4 py-3">
            <p className="text-[11px] uppercase tracking-[0.12em] text-faint">Why Drift flagged it</p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
              That file imports and calls the changed function, so the finding is tied to a real
              usage site rather than a name match.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
