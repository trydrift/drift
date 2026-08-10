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
const TIER_STYLE: Record<SupportTier, { chip: string; dot: string }> = {
  deep: {
    chip: "border-brand/45 bg-brand-soft text-brand-text",
    dot: "bg-brand",
  },
  strong: {
    chip: "border-brand/25 bg-brand-soft/50 text-brand-text",
    dot: "bg-brand/55",
  },
  working: {
    chip: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    dot: "bg-amber-500/70",
  },
  limited: {
    chip: "border-border bg-surface-hover text-faint",
    dot: "bg-faint/50",
  },
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
      </div>

      {/* The seven bars on each card need a key, or they are decoration.
          Naming the stages here once beats repeating them on sixteen cards,
          and the exact sentence for any one of them is on hover. */}
      <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10.5px] text-faint">
        <span>each bar is a stage:</span>
        {CAPABILITY_STAGES.map((stage, index) => (
          <span key={stage}>
            {index > 0 && <span className="mr-2">·</span>}
            {STAGE_LABEL[stage]?.toLowerCase()}
          </span>
        ))}
        <span className="ml-1 flex items-center gap-1.5">
          <span className={cn("h-1.5 w-5 rounded-full", LEVEL_STYLE.full)} /> full
          <span className={cn("ml-1 h-1.5 w-5 rounded-full", LEVEL_STYLE.partial)} /> partial
          <span className={cn("ml-1 h-1.5 w-5 rounded-full", LEVEL_STYLE.none)} /> none
        </span>
      </p>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        {byTier.map((group) =>
          group.rows.map((capability) => (
            <EcosystemCard
              key={capability.ecosystem}
              capability={capability}
              hasRecording={recorded.has(capability.ecosystem)}
            />
          )),
        )}
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

function EcosystemCard({
  capability,
  hasRecording,
}: {
  capability: EcosystemCapability;
  hasRecording: boolean;
}) {
  const style = TIER_STYLE[capability.tier];

  return (
    <div className="rounded-2xl border border-border bg-surface/60 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[13.5px] font-medium text-foreground">{capability.label}</p>
          <p className="mt-0.5 truncate font-mono text-[10.5px] text-faint">
            {capability.managers.join(" · ")}
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full border px-2 py-0.5 text-[10.5px] font-medium",
            style.chip,
          )}
        >
          {TIER_LABEL[capability.tier]}
        </span>
      </div>

      {/* Seven dots, one per stage, in pipeline order. Dense on purpose: the
          card answers "how much of Drift do I get" before anyone reads a word,
          and the full sentence for each stage is a hover away and written out
          in docs/support.md. */}
      <div className="mt-3.5 flex items-center gap-1">
        {CAPABILITY_STAGES.map((stage) => {
          const support = capability.support[stage];
          if (!support) return null;
          return (
            <span
              key={stage}
              title={`${STAGE_LABEL[stage]}: ${LEVEL_WORD[support.level]}${
                support.note ? ` — ${support.note}` : ""
              }`}
              className={cn("h-1.5 flex-1 rounded-full", LEVEL_STYLE[support.level])}
            />
          );
        })}
      </div>

      <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-faint">
        <span title={BASIS_TITLE[capability.localizationBasis]}>
          names: {BASIS_LABEL[capability.localizationBasis]}
        </span>
        <span aria-hidden>·</span>
        <span>{hasRecording ? "recorded above" : "no recording yet"}</span>
      </p>
    </div>
  );
}
