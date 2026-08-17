# Fix plans

**A migration described once, as a rule, and applied by Drift to every call
site at once.**

A fix plan is the tier between Drift's own codemod engine and handing a
finding to an AI agent. The difference from both is where the judgement
happens:

| | Who decides the edit | Cost | What survives afterwards |
| --- | --- | --- | --- |
| **Built-in codemod** | Drift, from a computed API diff | Free | A rule, in the plan |
| **Fix plan** | A model, a cache, or a recipe — *proposes*; Drift *validates* | One model call per finding | A rule, its evidence, its coverage, and its refusals |
| **AI agent** | The agent, per call site | One agent turn per commit | A diff |

The economics are the obvious argument: a finding that bites in fifty files
costs exactly what a finding that bites in one costs, because the model is
asked for the *rule*, not for fifty edits. The auditability is the better
one. Six months later, "why did this line change?" is answerable from the
plan — which rule fired, what evidence attested it, which call sites it
declined and why — instead of from a diff and a commit message.

---

## The cycle

```
evidence → propose a rule → validate it → apply it, anchored → verify → commit
              ↑                  │
        cache · recipe · model   └──→ rejected, or residual sites → AI agent, per site
```

Nothing is written to your repository before validation. Application happens
in a disposable git worktree, the project's own checks run there, and only
then is anything committed — so there is no "apply, test, then apply again"
step and no window where an unproven edit sits in a real tree.

## Proposal sources

Many sources, **one gate**. The order is by cost, not by trust — trust is not
ranked at all, because every source lands at the same validator and none of
them can skip it.

1. **The cache.** Free. Keyed on the migration — dependency, version range,
   change kind, symbols — and deliberately *not* on the repository, so a plan
   validated for one codebase is a candidate for any other hitting the same
   upstream break. A restored plan is re-validated against your call sites
   exactly as a fresh one is: the cache saves the authoring call, never the
   checking.
2. **A community recipe.** Costs a sandbox. The recipe runs in a throwaway
   worktree, Drift reads the before/after pairs it produced, and infers which
   of *its own* operations would explain them. A recipe whose edits Drift
   cannot re-derive is declined. See [below](#community-recipes-are-an-input-not-an-override).
3. **A model.** Costs one call per finding. Shown the evidence Drift
   retrieved and a sample of the real lines in your repository, and asked for
   the rule. Requires `llm.enabled` and an API key.

## The operations

A closed vocabulary. A plan Drift cannot re-derive the effect of is a plan
Drift cannot prove anything about, and an unprovable deterministic fix is
just an AI fix with extra steps.

| Operation | What it does | Assurance |
| --- | --- | --- |
| `rename-identifier` | `connect(…)` → `createConnection(…)`. Bare identifiers only — never `obj.connect`. | `proven` |
| `rename-member` | `client.connect` → `client.createConnection`. Members only — never a bare `connect`. | `proven` |
| `replace-import-path` | The module specifier moves. Only on lines that actually import, and only where that specifier appears once. | `proven` |
| `insert-argument` | A required argument was added. **Literals only** — never an expression, because an expression can call something. | `checked` |
| `wrap-call` | `f(…)` → `await f(…)` or `new f(…)`. | `checked` |

**Assurance** is what Drift can promise *without* running your checks, and it
is a claim with two halves.

`proven` means the operation swaps one token or string for another of the
same syntactic class — so it cannot change whether the file parses — **and**
that it edits only the exact occurrence Drift localized. Both halves are
enforced, not asserted: see [exact anchoring](#anchors-are-occurrences-not-lines)
for why the second half is not free.

`checked` means the operation changes the structure of an expression —
`await` outside an async function does not parse, and an inserted argument
may be the wrong arity — so Drift knows exactly what it will write but cannot
promise the result compiles.

## Anchors are occurrences, not lines

An anchor names **one occurrence**: file, line text, line number, column, and
the exact text matched there. Not a line. The distinction is the whole safety
property of the tier, and it is easiest to see in the case that motivated it:

```ts
primary.oldMethod(); backup.oldMethod();
```

Localization matches once per line, so Drift established exactly one of these
— say `primary`, whose receiver it proved was bound from the dependency that
moved. `backup` may be anything at all. A line-level anchor re-ran the rule
across the whole line and rewrote **both**, while the plan called itself
`proven`. The label was doing real damage: `proven` plans are the ones
`autoApply` will run unattended.

So an operation now resolves to a single splice inside the anchored
occurrence. There is no code path by which it can reach a second occurrence
of the same name — not on the line, not in the file.

Three consequences worth knowing:

- **A site with no column is residual.** The call-opens-on-next-line
  fallback matches a line without establishing an occurrence on it. Drift
  will not invent a position it never localized, so that site goes to an
  agent, which can read the surrounding code as a line-based rule cannot.
- **Relocation is stricter.** If earlier commits in the same run shifted the
  file, an anchor relocates by its exact line text — but only when that text
  is unique *and* the occurrence is still at the recorded column. Otherwise
  the site is left alone rather than guessed at.
- **Idempotence is structural.** Once an occurrence is rewritten,
  `matchedText` is no longer at `column`, the anchor stops resolving, and a
  second application finds nothing to do.

Stored plans from before this change use line-level anchors and are
**rejected rather than upgraded**. The missing information — which occurrence
— is exactly what made the old form unsafe, so reading them optimistically
would reintroduce the bug on every cached plan. The fix plan schema version
is `2`; version `1` plans fail validation and are treated as a cache miss.

## What the gate checks

1. **Shape.** Every parameter is the syntactic class its operation claims. An
   "identifier" containing a parenthesis is not an identifier. This is what
   stops a transform vocabulary from quietly becoming an arbitrary-code
   vocabulary.
2. **Grounding.** Every operation acts on a symbol the finding names. A rule
   about something else is either a misunderstanding or a second, unreported
   migration riding along inside the first — and the second is worse, because
   it would land under a commit message describing something else.
3. **Attestation.** Every name the plan would introduce appears in the cited
   evidence, as a whole token. This is the most important check here. A model
   asked to migrate an API it does not know will invent a confident,
   well-named, entirely fictional replacement — and a deterministic engine
   will then apply that fiction to every call site in the repository, faster
   and more thoroughly than any per-site agent would have. **Determinism
   multiplies whatever it is given.** This check is what makes sure it is
   given a fact.
4. **Exact occurrence.** Every edit is anchored to one call site
   localization established — file, line, column, matched text — and an
   operation is structurally incapable of reaching any other occurrence. A
   site whose occurrence Drift could not pin down is residual, not guessed.
5. **Convergence**, proved by running the plan twice rather than argued for.
6. **Line preservation**, likewise. No operation splits or joins a line.

A plan that fails any of these is rejected outright and the finding falls
through to an agent. The rejection is kept and reported: "Drift tried a
deterministic fix and rejected it because the replacement was not attested"
and "Drift never tried" are different facts, and only the first is a reason
to read the agent's output harder.

## Coverage is per call site

A rule explaining nine of ten call sites resolves nine, and the tenth is
handed to an agent individually with a reason attached. This is different
from the built-in codemod engine, which is all-or-nothing per commit — a
defensible rule when the fix was free to derive, and the wrong one when it
cost a model call.

`remediation.fixPlans.minCoverage` (default `0.5`) is the floor. Below it, a
plan is discarded: a rule explaining one call site out of forty is not wrong,
but it is not a migration either, and acting on it splits one finding across
two mechanisms for no benefit.

## Reviewing a plan before it happens

```console
$ drift fix --plan
```

Writes nothing — no worktree edit, no commit, no branch, no agent — and
prints every plan: the rule, the evidence attesting it, every call site it
would change (before → after), and every call site it would decline and why.

The same document, from the same renderer, is what the VS Code extension
shows in its confirm prompt and what the GitHub Action puts in the commit
message, the pull request body, and the approval issue. One renderer,
deliberately: a reviewer who approves a plan in the editor and an auditor who
reads it on a pull request a year later must be looking at the same document,
and a per-surface summary would let them differ — with the one that differed
being the one nobody checked.

## Auto mode

`remediation.fixPlans.autoApply` decides whether a plan may be applied
without a human seeing it first.

| Value | Behaviour |
| --- | --- |
| `review` (default) | Always write the document and ask, on every surface that can ask. |
| `proven` | Apply plans whose every operation is `proven`. Ask about the rest. |
| `verified` | Also apply `checked` plans, once the project's own checks have actually passed against them. |

There is deliberately no `always`. **A `checked` plan whose verification did
not run is never applied unattended, at any setting** — that combination is
precisely where a deterministic engine would propagate a mistake faster than
any per-site agent could. Note also that verification being *switched off* is
not verification that *passed*; the two are distinguished.

`mode: approve` reviews everything regardless. A repository that asks before
an agent edits it is not asking to be edited deterministically instead.

## Community recipes are an input, not an override

Recipes used to be an execution tier: a matching recipe's edits were
scope-checked and committed. Scope checking answers "did it stay in its
lane". It does not answer "is this the right edit" — and a pipeline that
demanded a model prove its rule while asking a third-party program for
nothing had the trust backwards.

A recipe is now a proposal source. It runs in a throwaway worktree, purely to
be observed. Drift reads what it did, infers its own operations, and puts the
result through the same gate everything else goes through. What reaches your
repository is Drift's operations, applied by Drift's executor, anchored to
Drift's localized impact sites. The recipe's output is discarded along with
the worktree.

This is strictly less than recipes could do before, and deliberately: a
recipe whose edits Drift cannot re-derive is a recipe Drift cannot describe
in a plan document, and an indescribable deterministic fix is exactly the
thing this tier exists to stop shipping. When that happens the finding goes
to an agent, and the report says the recipe was *consulted* rather than
implying a fix is available.

`remediation.communityRecipes` still gates the network call, unchanged.

## Configuration

```yaml
remediation:
  fixPlans:
    # Ask a model to author plans. Needs llm.enabled and an API key.
    # Off by default — but cached and recipe-derived plans still work
    # without it, since neither costs a model call.
    enabled: false

    # Fraction of a finding's call sites a plan must cover to be used.
    minCoverage: 0.5

    # review | proven | verified
    autoApply: review

    # Reuse plans validated for the same migration elsewhere.
    cache: true

llm:
  enabled: true
  model: claude-opus-5
  apiKeyEnv: ANTHROPIC_API_KEY
```

Plans are cached under `~/.drift/cache/fixplans/` (`DRIFT_CACHE_DIR` moves
it, `DRIFT_NO_CACHE=1` disables it) as plain JSON — readable, diffable, and
shareable as migration recipes in their own right. Entries written before the
exact-anchor change declare `schemaVersion: 1` and are ignored; they are
re-authored on next use rather than reinterpreted.

## Where the code lives

```
src/fixplan/
├── schema.ts      the closed op vocabulary and the document shape
├── execute.ts     the only thing that edits a line, and it is pure
├── validate.ts    the gate
├── infer.ts       reads a rule back out of edits somebody else made
├── author.ts      one model call per finding, not per call site
├── from-recipe.ts a recipe's observed edits, re-derived
├── sandbox.ts     where a recipe runs, and cannot do harm
├── cache.ts       plans addressed by migration, not by repository
├── resolve.ts     many proposal sources, one gate
├── policy.ts      the one auto-apply decision every surface asks
└── document.ts    the artefact the tier exists to produce
```

See also [architecture.md](architecture.md) for where this sits in the
pipeline, and [configuration.md](configuration.md#remediationfixplans) for
every setting.
