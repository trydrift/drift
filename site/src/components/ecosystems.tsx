import { cn } from "@/lib/cn";
import {
  CAPABILITY_STAGES,
  ECOSYSTEM_CAPABILITIES,
  STAGE_LABEL,
  TIER_DESCRIPTION,
  type EcosystemCapability,
  type SupportLevel,
  type SupportTier,
} from "@/lib/capabilities";

/**
 * Every ecosystem, and how far Drift actually gets in each.
 *
 * The page used to show seven and say nothing about the other nine, which is
 * the shape of claim that costs trust twice: a Dart developer concluded Drift
 * did not support Dart, and a PHP developer who found out it did was entitled
 * to wonder what else the page had rounded off.
 *
 * So all sixteen are here, graded — and the grade is *computed*, in
 * `src/detect/capabilities.ts`, from the same data the CLI consults before it
 * runs a stage and the same data `docs/support.md` is generated from. Nobody
 * types a badge colour. An ecosystem that loses a capability loses its colour
 * on the next build, which is the only arrangement under which a support table
 * on a marketing page stays true.
 *
 * The uncomfortable rows are the point. CocoaPods cannot be verified because
 * building an iOS target needs a scheme Drift cannot infer; OCaml's module
 * names are a convention rather than a published fact. Both are on the page,
 * in the same table, in the same words the docs use.
 *
 * Drawn as a matrix rather than sixteen separate cards: a row is an ecosystem,
 * a column is a stage, and a cell is one answer. That is the actual shape of
 * the data, so laying it out any other way asked a reader to reconstruct the
 * grid in their head — counting which green rectangle on which card lined up
 * with which stage — instead of just seeing it.
 *
 * Nine stages have to fit next to a name column on a 360px phone with nothing
 * abbreviated and nothing scrolled off-screen. Turning the stage headers on
 * their side is what makes that arithmetic work: a vertical word is as wide as
 * one character no matter how long it is, so nine full names cost the same
 * horizontal space nine three-letter codes would have — and nobody has to
 * remember what a code stood for.
 */

const TIER_ORDER: readonly SupportTier[] = ["deep", "strong", "working", "limited"];

const TIER_LABEL: Record<SupportTier, string> = {
  deep: "Deep",
  strong: "Strong",
  working: "Working",
  limited: "Limited",
};

/**
 * One step down the palette per tier, rather than four unrelated hues.
 *
 * Green means "Drift can answer the question here" and the saturation says how
 * completely. Amber and neutral at the bottom are doing the work a fifth green
 * could not: they read as *caution* at a glance, which is the correct first
 * impression of an ecosystem where the judgement is still the developer's.
 */
const TIER_STYLE: Record<SupportTier, { dot: string }> = {
  deep: { dot: "bg-brand" },
  strong: { dot: "bg-brand/55" },
  working: { dot: "bg-amber-500/70" },
  limited: { dot: "bg-faint/50" },
};

const BASIS_LABEL: Record<EcosystemCapability["localizationBasis"], string> = {
  declared: "manifest",
  published: "published",
  convention: "convention",
};

const BASIS_TITLE: Record<EcosystemCapability["localizationBasis"], string> = {
  declared: "The manifest coordinate is the import name — nothing to infer.",
  published:
    "Read from the artefact the registry published: a wheel's top_level.txt, a jar's packages, Composer's PSR-4 map.",
  convention:
    "No published module list exists, so Drift applies the ecosystem's naming convention.",
};

const LEVEL_STYLE: Record<SupportLevel, string> = {
  full: "bg-brand",
  partial: "bg-brand/40",
  none: "bg-border",
};

const LEVEL_WORD: Record<SupportLevel, string> = {
  full: "yes",
  partial: "partial",
  none: "no",
};

/** Rotated to read bottom-to-top, so the label is never truncated. */
const VERTICAL_LABEL: React.CSSProperties = {
  writingMode: "vertical-rl",
  transform: "rotate(180deg)",
};

export function Ecosystems({ recorded }: { recorded: ReadonlySet<string> }) {
  const byTier = TIER_ORDER.map((tier) => ({
    tier,
    rows: ECOSYSTEM_CAPABILITIES.filter((capability) => capability.tier === tier),
  })).filter((group) => group.rows.length > 0);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {TIER_ORDER.map((tier) => (
          <span key={tier} className="flex items-center gap-1.5 text-[12px] text-muted">
            <span className={cn("size-2 rounded-full", TIER_STYLE[tier].dot)} />
            {TIER_LABEL[tier]}
          </span>
        ))}
        <span className="ml-auto flex items-center gap-1.5 text-[12px] text-muted">
          <span className={cn("h-1.5 w-5 rounded-full", LEVEL_STYLE.full)} /> Full
          <span className={cn("ml-1 h-1.5 w-5 rounded-full", LEVEL_STYLE.partial)} /> Partial
          <span className={cn("ml-1 h-1.5 w-5 rounded-full", LEVEL_STYLE.none)} /> None
        </span>
      </div>
      <p className="mt-2 text-[11.5px] text-faint">Tap or hover a cell for the exact sentence.</p>

      {/* The matrix. Every column is sized to fit a phone without scrolling —
          the overflow-x-auto is a safety net for the very narrowest devices,
          never the intended way to read it. */}
      <div className="mt-5 overflow-hidden rounded-2xl border border-border bg-surface/60">
        <div className="overflow-x-auto">
          <table className="w-full min-w-0 border-collapse text-left table-fixed">
            <colgroup>
              <col className="w-26 sm:w-36 lg:w-52" />
              {CAPABILITY_STAGES.map((stage) => (
                <col key={stage} />
              ))}
            </colgroup>
            <thead>
              <tr className="border-b border-border">
                <th
                  scope="col"
                  className="sticky left-0 z-10 border-r border-border bg-surface-hover/70 px-2 py-2 text-[10px] font-medium uppercase tracking-wide text-faint sm:px-3"
                >
                  Ecosystem
                </th>
                {CAPABILITY_STAGES.map((stage) => (
                  <th key={stage} scope="col" className="px-0 py-1.5 text-center align-bottom">
                    <span
                      style={VERTICAL_LABEL}
                      className="inline-block whitespace-nowrap text-[9px] font-medium tracking-tight text-faint sm:text-[10px]"
                    >
                      {STAGE_LABEL[stage]}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {byTier.map((group) =>
                group.rows.map((capability) => (
                  <EcosystemRow
                    key={capability.ecosystem}
                    capability={capability}
                    hasRecording={recorded.has(capability.ecosystem)}
                  />
                )),
              )}
            </tbody>
          </table>
        </div>
      </div>

      <dl className="mt-6 grid gap-2 border-t border-border pt-5 sm:grid-cols-2">
        {TIER_ORDER.map((tier) => (
          <div key={tier} className="flex gap-2.5">
            <dt className="shrink-0 pt-0.5">
              <span className={cn("inline-block size-2 rounded-full", TIER_STYLE[tier].dot)} />
            </dt>
            <dd className="text-[12.5px] leading-relaxed text-muted">
              <span className="font-medium text-foreground">{TIER_LABEL[tier]}</span> —{" "}
              {TIER_DESCRIPTION[tier]}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function EcosystemRow({
  capability,
  hasRecording,
}: {
  capability: EcosystemCapability;
  hasRecording: boolean;
}) {
  const style = TIER_STYLE[capability.tier];

  return (
    <tr className="group border-b border-border/60 last:border-0 even:bg-surface-hover/20 hover:bg-surface-hover/50">
      <th
        scope="row"
        title={`${capability.managers.join(" · ")} · names resolved via ${
          BASIS_LABEL[capability.localizationBasis]
        }: ${BASIS_TITLE[capability.localizationBasis]} ${
          hasRecording ? "Recorded above." : "No recording yet."
        }`}
        className="sticky left-0 z-10 border-r border-border bg-surface px-2 py-2 text-left align-middle group-even:bg-[color-mix(in_srgb,var(--surface-hover)_20%,var(--surface))] group-hover:bg-[color-mix(in_srgb,var(--surface-hover)_50%,var(--surface))] sm:px-3"
      >
        <p className="flex items-center gap-1.5">
          <span className={cn("inline-block size-1.5 shrink-0 rounded-full", style.dot)} />
          <span className="truncate text-[11.5px] font-medium text-foreground sm:text-[12.5px]">
            {capability.label}
          </span>
        </p>
      </th>
      {CAPABILITY_STAGES.map((stage) => {
        const support = capability.support[stage];
        return (
          <td key={stage} className="px-0 py-2 text-center align-middle">
            {support ? (
              <span
                title={`${capability.label} · ${STAGE_LABEL[stage]}: ${LEVEL_WORD[support.level]}${
                  support.note ? ` — ${support.note}` : ""
                }`}
                className={cn("mx-auto block size-2 rounded-xs sm:size-2.5", LEVEL_STYLE[support.level])}
              />
            ) : (
              <span className="mx-auto block size-2 rounded-xs border border-dashed border-border/70 sm:size-2.5" />
            )}
          </td>
        );
      })}
    </tr>
  );
}
