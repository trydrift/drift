# Can Drift make a coding agent more accurate and cheaper? No.

> **Scope.** Every configuration below pastes Drift's report or brief in front
> of a raw agent. The product's own Fix with AI was measured separately, after
> it was rebuilt, and reaches parity with the raw agent (29/30 against 25/30):
> see [`fix-with-ai.md`](fix-with-ai.md).

276 live agent sessions, 216 valid trials, eleven real repositories, five
configurations, two suite versions. The target was a configuration that beats
an unaided agent on **both** success rate and input tokens. Nothing reached it,
and the reasons are structural rather than a matter of more tuning.

## Every configuration tried

| Configuration | Valid | Success | Rate | Tokens vs baseline |
| --- | ---: | ---: | ---: | ---: |
| **Baseline** (agent as it ships) | 63 | 61 | **96.8%** | — |
| Lean tool set, no context | 30 | 24 | 80.0% | −42.4% |
| Drift's PR report + lean tools | 30 | 28 | 93.3% | +12.4% |
| Drift's PR report + full tools | 30 | 25 | 83.3% | +28.4% |
| **Compact brief + full tools** | 63 | 59 | **93.7%** | −8.8% to −17.2% |

The compact brief is the best of them and still does not win: it matches the
baseline's accuracy in one run (29/30), loses in another (27/30), and ties on
the large upgrade (3/3) while costing 4% more tokens there.

## Why accuracy cannot be improved

**The baseline agent already scores 96.8%.** Two failures in sixty-three
trials. There is no headroom: an intervention would have to be perfect
*and* fix both, and a one-trial difference is noise at this sample size.

**Context causes anchoring, reliably.** An agent told what is wrong stops
looking for what else might be. The clearest instance: on `lru-cache` 7 → 10
the unaided agent fixed the `maxSize` trap 6 times out of 6; the agent holding
Drift's brief fixed it 4 times out of 6. The brief was rewritten specifically
to counter this — it now states that Drift diffs exported symbols and is blind
to a name that changed meaning, and names the removed symbols localization
could not place — and the failure still recurred. This is automation bias, it
is well documented outside this repository, and prompt wording did not remove
it.

**Drift often does not hold the fact that matters.** The `maxSize` /
`sizeCalculation` requirement entered lru-cache in **7.0**; the upgrade under
test starts at **7.18.3**. It appears in no changelog section inside the range,
and Drift's entire evidence for that upgrade is 102 bytes of semver text, a
1,577-byte type-surface diff and a 248-byte changelog slice. No tool that
diffs 7.18.3 → 10.4.3 can know it. The brief can only ask the agent to look,
which is a hint, not a fix.

## Why tokens cannot be reduced much either

Token cost is `prompt × model calls`, and research is a small share of it.
Measured on the baseline: 27 model calls, ~59k gross input per call, of which
roughly half is the fixed system-and-tools preamble re-read every call and most
of the rest is the accumulated transcript. File reading is a few percent.

The PR report (~19,000 tokens) is charged on every call: ~500k per session,
against the two tool calls it saved. Replacing it with the ~800-token brief is
what produced the only genuine reduction here, 9–17% depending on the run.
That is real, but it is a saving against *Drift's own overhead*, not against
the unaided agent's work.

**And the compiler is already the localizer.** On the large case — 15 errors
across 3 files, the shape where a localization tool should win — the agent ran
`tsc`, got every site with file and line, and finished in the same number of
calls as with Drift's list. Drift's impact analysis duplicates, less precisely,
what `tsc --noEmit` prints for free in a typed ecosystem.

## What would have to be true for this to work

An intervention would need to supply something the agent cannot get from the
compiler and the package's own types: the *semantics* of names that survived
the upgrade. Drift's evidence layer does not currently extract that, and for
the one case where it mattered the information was outside the version range
entirely. Building that is not a prompt change; it is a different product
capability, and it would have to beat a 96.8% baseline to show up at all.

## Recommendation

Do not ship a token-savings or accuracy claim for agent-assisted upgrades.
Nothing here supports one, and the benchmark's own publication gates should
keep refusing to render one.

The measured, defensible results from this work are narrower and real: the
compact brief costs ~95% fewer tokens than the pull-request body for the same
job, the anchoring finding is worth knowing for anyone putting analysis in
front of an agent, and the ten-case suite with hidden behavioural validators is
a reusable asset. Drift's value, if it has one, is in the places this benchmark
never measured — telling a human what changed and gating CI — not in making an
agent that already succeeds 96.8% of the time succeed more often for less.
