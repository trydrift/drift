# Research foundation

Drift's localization strategy is adapted from
**[LLM Agents for Automated Dependency Upgrades](https://arxiv.org/html/2510.03480v1)**
(arXiv:2510.03480), which introduces **LADU**, built on the ALMAS multi-agent
framework.

This document records what Drift took, what it changed, and why — including the
places where the paper's approach didn't fit and we went a different way.

---

## What the paper does

LADU upgrades Java library dependencies with a three-agent architecture:

| Agent | Role |
|---|---|
| **Summary Agent** | Produces AST-aligned one-line natural-language summaries of every code unit and file |
| **Control Agent** | Retrieves over those summaries (**Meta-RAG**) to choose which units to read and which to write; consults a migration guide |
| **Code Agent** | Applies the edits (GPT-4o) |

An iterative resolution loop compiles, runs tests, and feeds failures back to the
Control Agent, up to n=3 iterations.

### Reported results

Evaluated on three synthetic Spring Boot repositories (3.1→3.2, 3.2→3.3,
3.3→3.4), against an OpenHands baseline:

| Metric | OpenHands | LADU |
|---|---|---|
| Steps (3.1→3.2) | 106 | **18** |
| Tokens (3.1→3.2) | 1,514,456 | **78,421** |
| Precision (3.2→3.3) | 17.2% (22/128 correct) | **71.4%** (5/7 correct) |

Meta-RAG reduces codebase token footprint by ~79.9%.

### The finding that matters most

The precision number, not the token number. OpenHands removed **128 lines to get
22 right**; LADU removed **7 to get 5 right**. A general-purpose coding agent
pointed at "upgrade this dependency" makes a large number of unrequested changes,
and 83% of them were wrong.

**Precision is the product.** A tool that fixes your breakage while quietly
rewriting 100 unrelated lines has not helped you — it has handed you a bigger
review and a worse diff. Drift's guardrails, scoped per-commit file lists, and
explicit "change only what is required" instruction all exist because of this
result.

---

## What Drift adopted

### Meta-RAG retrieval

Index over condensed metadata rather than raw source. `src/index/metarag.ts`
builds file summaries, per-unit entries, and — Drift's addition — an import
graph.

### Structured control before generation

The paper separates deciding *what* to change from *making* the change. Drift
does the same, with the split at a different seam: stages 1–5 decide, stage 6
delegates to Copilot. Everything before dispatch is deterministic and inspectable.

### Migration guides as first-class input

`fetchMigrationGuide` probes `MIGRATING.md`, `UPGRADING.md`, and friends. Drift
weights a guide at 0.80 — high, but as one source among several rather than the
foundation.

### Human handover with a process summary

The paper notes LADU hands over to a human when it can't resolve something. Drift
generalises this into the whole approval flow, and instructs the agent that a
flagged `TODO(drift):` is a better outcome than a confident guess.

---

## Where Drift departs, and why

### 1 · Breaking-change detection: computed, not assumed

**Paper:** "the control agent consults a migration guide for the target version…
Without a guide, the system defaults to internal LLM knowledge."

**Drift:** computes API diffs from the artifacts themselves — `.d.ts` surfaces
for npm, OpenAPI specs for HTTP dependencies — and treats guides as one weighted
source among six.

**Why:** falling back to "internal LLM knowledge" is exactly the failure mode
that makes an autonomous tool unsafe on someone's production repository. A model
recalling a package's API is a *guess presented with confidence*, and a wrong
guess sends an agent to edit working code.

It's also an availability problem. Most packages outside the Spring ecosystem
have no migration guide at all — a guide-dependent design would simply not fire
for most of the real world. And changelogs lie by omission: the most common cause
of a "minor" upgrade breaking a build is a removal nobody wrote down. Only a
computed diff catches that.

This is Drift's most significant departure and the core of its trust argument.

### 2 · Summaries: structural, not LLM-generated

**Paper:** a Summary Agent generates natural-language summaries per code unit.

**Drift:** summaries are derived from signatures — free, deterministic, requiring
no API key, and incapable of hallucinating.

**Why:** the two systems ask different questions. LADU's Control Agent needs
*semantic* recall — "which code might relate to Spring Boot's actuator?" — and
prose is a good index for that. Drift arrives at localization already knowing the
exact identifiers it's hunting, because the evidence stage extracted them. For
"which unit touches `createClient`?", a signature is a *better* index than prose,
and an LLM pass over the whole codebase would be a large cost for negative value.

It also means Drift's core pipeline runs with no model and no API key at all.

### 3 · Output: separated commits, not a working tree

**Paper:** produces an upgraded codebase, evaluated by line-level diff against a
gold standard.

**Drift:** produces a branch, ordered atomic commits, a pull request, and a
report with citations.

**Why:** the paper's contribution is the upgrade mechanism; Drift's product is
the *reviewability* of the result. Given the 17.2%-precision baseline, a reviewer
needs to verify an agent's work — and verifying one 40-file commit is materially
harder than verifying six commits each doing one thing. Separated commits also
keep `git revert` and `git bisect` meaningful when a fix turns out wrong.

### 4 · Verification loop: delegated, not owned

**Paper:** LADU owns the compile-test-repair loop, up to 3 iterations.

**Drift:** Copilot runs its own build-and-test loop inside its session; Drift
supplies the plan and the constraints.

**Why:** Drift would have to replicate per-ecosystem build tooling that Copilot's
agent environment already has. The honest trade-off is that Drift currently has
less visibility into the repair loop than LADU does — see
[architecture.md § Known limitations](architecture.md#known-limitations).

### 5 · Ecosystem scope

**Paper:** Java/Maven, evaluated on Spring Boot.

**Drift:** thirteen ecosystems for detection. Consequently Drift's computed-diff
coverage is uneven — a local toolchain gives npm, Go, Cargo, Maven, and Python a
computed surface diff; RubyGems and the rest fall back to prose evidence, with
no computed signal at all for RubyGems. Stated in the limitations rather than
smoothed over.

---

## Summary

| Dimension | LADU | Drift |
|---|---|---|
| Retrieval | Meta-RAG over LLM summaries | Meta-RAG over structural summaries + import graph |
| Breaking-change source | Migration guide, else LLM recall | Computed API/spec diffs + 4 prose sources, weighted |
| Agents | Summary, Control, Code | Deterministic detect→plan stages; codemod, then a community recipe, then Copilot to resolve each commit |
| Evidence trail | Not a design goal | Mandatory — every finding cites a source |
| Output | Working tree | Branch + separated commits + PR + report |
| Autonomy control | Not addressed | Guardrails, risk gating, approval mode |
| Ecosystems | Java/Maven | 13, incl. npm, PyPI, Go, Cargo, Maven, RubyGems |
| LLM required | Yes (GPT-4o) | No — optional recall assist only |

The paper's contribution Drift relies on most is not Meta-RAG itself. It's the
demonstration that **a general-purpose coding agent pointed at a dependency
upgrade will make many more changes than it should**. Every guardrail in Drift is
a response to that measurement.

## Citation

```bibtex
@article{ladu2025,
  title  = {LLM Agents for Automated Dependency Upgrades},
  year   = {2025},
  eprint = {2510.03480},
  archivePrefix = {arXiv},
  url    = {https://arxiv.org/html/2510.03480v1}
}
```
