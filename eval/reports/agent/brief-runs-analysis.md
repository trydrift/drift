# The compact brief: two runs, and what they actually establish

The pull-request body was replaced, as the agent's context, by the product's
own agent brief — ~800 tokens against ~19,000 — with three changes to what that
brief says. Two full runs later the token result is real and the accuracy
result is not.

## The two runs

| | Baseline | Drift + brief | Median token change |
| --- | ---: | ---: | ---: |
| Run A (suite v1, 30+30 trials) | 29/30 | **29/30** | **−17.2%** |
| Run B (suite v2, 30+30 trials) | 29/30 | **27/30** | **−8.8%** |
| Pooled | 58/60 (96.7%) | 56/60 (93.3%) | ~−13% |

Run B is the same configuration as run A on the same ten repositories, with one
hidden assertion corrected. It did not replicate: `hosts-lru-cache-10` went 3/3
to 1/3 with nothing about the brief changed.

## What changed in the brief, and why

Each change came from a measured failure, and each is about a class of
behaviour rather than a case.

1. **The instructions stopped telling the agent not to look.** They used to
   read "do not independently enumerate the package API or changelog". Drift
   diffs exported symbols, so a name that survives an upgrade and changes
   meaning is invisible to it; that sentence turned Drift's structural blind
   spot into the agent's.
2. **Findings localization could not place are named, not counted**, while the
   list is short enough to act on. An options interface is used structurally —
   an object literal satisfying it — and no identifier search finds that.
3. **The brief states the constraints Drift's patch validation enforces.** An
   agent that learns "do not lower coverage thresholds" by having its work
   rejected has already paid for the session.

The first two aimed at one failure in particular: on lru-cache 7 → 10 the agent
fixed the named import and left `maxSize`, which kept its name and now throws
on every `set` without a companion option.

## Why that failure cannot be fixed from Drift's evidence

The `maxSize`/`sizeCalculation` requirement entered lru-cache in **7.0**. The
upgrade under test starts at **7.18.3**. It appears nowhere in the 8.0, 9.0 or
10.0 changelog sections, and Drift's entire evidence for this upgrade is 102
bytes of semver boilerplate, a 1,577-byte type-surface diff, and a 248-byte
changelog slice. Drift does not know, and no diff of this version range can
know: the constraint predates the range.

So the brief can only ask the agent to look. Asking works sometimes — 3/3 in
run A, 1/3 in run B — which is exactly the shape of a hint, not a fix.

## The two things these runs establish

**Tokens: a real reduction, around 10–20%.** Both runs agree in direction and
the mechanism is legible — the brief is ~800 tokens where the report was
~19,000, and a prompt is re-read on every model call. Run A −17.2%, run B
−8.8%, per-case spread from −46% to +115%.

**Accuracy: no headroom on this suite, and a real cost to anchoring.** The
baseline agent scores 96.7% (58/60). There is one failure per thirty trials to
win back, which no intervention can beat by a measurable margin. Meanwhile the
agent given context inspects less: baseline catches the lru-cache trap 6/6,
the brief 4/6. That is automation bias, it is general, and no wording removed
it.

## What this suite cannot answer

Its median case has **two impact sites**. That is precisely where a
localization tool has least to offer — an agent finds two call sites by
itself — and it is why the accuracy column is a ceiling rather than a contest.

The untested claim is the one the tool is actually for: an upgrade with twenty
or ninety call sites across a dozen files, where an unaided agent has to find
them all before it can fix any. `getflywheel/local-components` on
react-router-dom 5 → 6 (24 sites) and `bufferapp/ui` on styled-components
5 → 6 (90 sites) are admissible candidates for that question, and nothing here
answers it.
