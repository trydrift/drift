# Drift Recording Forensic Audit

**Repository:** `trydrift/drift`  
**Audited main:** `a980fa757a512bf806b6b0b7d124a7b3417af2c6`  
**Recording refresh on audited main:** PR #96, merged 2026-08-25  
**Recordings:** `site/src/data/*.json`  
**Scope:** 16 recordings, 1,571 dependency checks, 867 outdated candidates

---

## 1. Executive verdict

The current recording set should **not** be used as an accuracy proof until the P0 issues in this document are fixed and the recordings are regenerated.

There are several distinct classes of confirmed false positives:

1. **Python public-surface identities are wrong.**
   - Extracted sdist directory names such as `itemloaders-1.0.1` and `parsel-1.5.0` become part of API identity.
   - `docs/` and example code are treated as exported package API.
   - This produces enormous fake removal sets when the archive-root version changes.

2. **C/C++ surface extraction reports APIs removed even when they still exist in the target release.**
   - Confirmed against spdlog 1.17.0, OpenSSL 4.0.1, GoogleTest, and FastLED.
   - The parser also misidentifies conversion operators and other declarations as members.

3. **Qualified symbols are weakened into unsafe bare-name searches.**
   - `basic_cstring_view.c_str` becomes `c_str`.
   - `TouchListWrapper.StateError` becomes `StateError`.
   - `UISlider.uint8_t` becomes `uint8_t`.
   - The resulting unrelated matches can still influence package verdicts.

4. **Runtime-change prose parsing is too broad and runtime localization is incorrect.**
   - “Dropped support for HS512256” is classified as a runtime requirement.
   - “Dropped support for importing internal files from lib/” is classified as a runtime requirement.
   - Unknown runtime symbols fall back to Node matching.
   - Every bare runtime version file is currently treated as a high-confidence site for every runtime finding.
   - A declaration is considered impacted even when it already satisfies the new minimum.

5. **Swift git-tag version selection mixes incompatible version schemes.**
   - Yoga `3.2.1` is incorrectly “upgraded” to the old date tag `2016.12.26`.

6. **Nested project discovery treats test fixtures as real projects.**
   - The Deno recording scans hundreds of `tests/registry/npm/.../package.json` fixture manifests.

There are also coverage weaknesses that are not false positives by themselves:
- OPAM/Cohttp largely produces “insufficient evidence.”
- Several recordings contain no localized impacts, but that is not equivalent to independent proof that every upgrade is safe.
- Quick recordings are explicitly not deep-verification results.

The right fix is **not** a larger symbol denylist and **not** package-specific exceptions. These failures originate in shared abstractions: canonical surface identity, owner-aware localization, structured runtime requirements, version-family selection, and project ownership discovery.

---

## 2. Audit methodology

Every recording was inspected at the candidate/result level. Candidates were divided into:

- **Affected / migration claim:** local impact sites are asserted.
- **Upstream-only:** upstream changes are asserted but no local use is located.
- **Clean/static result:** no breaking local use was located.
- **Insufficient/unchecked:** Drift could not obtain enough evidence.
- **Discovery/version anomaly:** the candidate itself should not have existed or the selected target is wrong.

For suspicious claims, the audit then traced:
1. the exact recording evidence;
2. the local matched code;
3. the upstream target API where necessary;
4. the current Drift source path that generated the result.

This audit does **not** independently reconstruct the complete release history of all 867 target packages. For packages with no local finding and no anomalous target/discovery state, the recording result is classified as “no obvious false-positive signal observed,” not as a proof that the package is semantically safe.

That distinction should remain in the regenerated recordings.

---

# 3. Recording-by-recording disposition

## 3.1 Supabase — npm / TypeScript

**Coverage:** 22 checked, 12 candidates  
**Hard local migration claims:** 0  
**Observed local symbol sites:** 0  
**Verdict:** No obvious false positive found in the recording.

Representative candidates include React/React DOM, Next, Radix packages, lucide-react, tailwind-merge, and iceberg-js.

The recording is a static Quick Scan. “No local breaking use found” is acceptable if the available type/prose evidence genuinely answered; it must not be presented as equivalent to deep verification.

**Action for Codex:** no package-specific change. Re-run after shared fixes and ensure these remain clean/unchecked according to actual evidence.

---

## 3.2 Scrapy — PyPI / Python

**Coverage:** 90 checked, 51 candidates  
**Unique hard migration candidates observed:** 6

- `itemloaders 1.0.1 → 1.4.0`
- `parsel 1.5.0 → 1.11.0`
- `protego 0.1.15 → 0.6.2`
- `queuelib 1.6.1 → 1.10.0`
- `w3lib 2.1.1 → 2.4.1`
- `twisted 21.7.0 → 26.4.0`

### Confirmed false-positive class: versioned archive root in Python API identity

The recording reports symbols such as:

- `itemloaders-1.0.1.itemloaders.processors.TakeFirst`
- `parsel-1.5.0.parsel.selector.Selector`
- `parsel-1.5.0.docs.conf.copyright`

The archive-root component is not Python import identity. A different extracted root in the target release therefore makes unchanged APIs appear removed.

`TakeFirst`, `MapCompose`, and `Compose` remain in itemloaders 1.4.0. The recording's removal is not a real API removal.

### Confirmed false-positive class: docs/examples treated as exported package API

Twisted 21.7.0 contains the documentation example:

`docs/core/examples/pbechoclient.py`

with a local callback:

```python
def failure(error):
    ...
```

Drift turns that into an API:

`Twisted-21.7.0.docs.core.examples.pbechoclient.failure`

and then reports it removed. It localizes the bare leaf `failure` onto Scrapy code that actually uses:

```python
from twisted.python import failure
failure.startDebugMode()
from twisted.python.failure import Failure
```

Those are the real `twisted.python.failure` module/class APIs and are unrelated to the docs callback. `startDebugMode()` still exists in modern Twisted.

### Current root cause

`src/evidence/surface/python.ts`

Current behavior:
- extracts an sdist into a temporary directory while preserving entry paths;
- walks the whole extraction root;
- derives the module name from `os.path.relpath(path, root)`;
- does not strip the single `<distribution>-<version>/` archive root;
- does not confine traversal to importable package roots;
- prunes tests but does not adequately exclude docs/examples/build metadata.

### Required fix

Build a canonical Python package surface independent of archive layout.

1. Strip the common top-level archive directory before computing module identity.
2. Determine importable package roots from package metadata/layout rather than treating every `.py` beneath the sdist as package API.
3. Exclude docs/examples/benchmarks/build scripts/config modules from the public surface unless they are genuinely importable members of the published package.
4. Preserve package/module/class/member ownership in canonical IDs.
5. Compare canonical IDs across versions.

### Required regression cases

- itemloaders `1.0.1 → 1.4.0`
  - `TakeFirst`, `MapCompose`, `Compose` are not removed.
- parsel `1.5.0 → 1.11.0`
  - `parsel.selector.Selector` identity is version-independent.
  - `docs.conf.*` never enters the public API surface.
- Twisted
  - `docs/core/examples/pbechoclient.py::failure` never becomes a public export.
  - Scrapy's `twisted.python.failure` imports never localize to it.

**Disposition:** The Scrapy Python computed-surface migration results are not trustworthy until this provider is fixed and the recording is regenerated.

---

## 3.3 GitLab — RubyGems/Ruby repository with substantial npm surface

**Coverage:** 632 checked, 355 candidates  
**Hard `Migration required` candidate count in recording:** approximately 35 unique candidates  
**Verdict:** mixed. Many ordinary import-linked findings may be legitimate, but a large runtime-derived subset is definitely synthetic.

Hard candidates observed include, among others:

- `@json-render/core`
- `@json-render/vue`
- `@apollo/client`
- multiple `@tiptap/*` packages
- `countries`
- `compression-webpack-plugin`
- `css-loader`
- `editorconfig`
- `gettext-parser`
- `graphql`
- `graphiql`
- `jwt`
- `lockbox`
- `lowlight`
- `react`
- `react-dom`
- `redis`
- `redis-clustering`
- `retriable`
- `sanitize`
- `three`
- `vue`
- `vue-router`
- `webpack-cli`
- `js-yaml`

### Confirmed false-positive class: arbitrary “dropped support” text becomes a runtime requirement

Current rule:

`src/analyze/rules.ts`

uses a broad rule equivalent to:

```ts
/dropped|drops|removed support for (anything)/
```

and classifies the match as `runtime-requirement`.

Confirmed nonsensical examples in the GitLab recording:

- `Dropped support for HS512256`
- `Dropped support for importing internal files from lib/`
- `Dropped support for Mongoid < 8`
- `Dropped support for using HTML comments (...)`

These are not runtime-version changes.

The remediation is consequently wrong too: it tells the developer to update CI runtimes, engine fields, and container images.

### Confirmed parser bug: invalid minimum version `"."`

The minimum-runtime regexp accepts `[\d.]+`, which accepts `"."`.

The recording contains:

`Minimum Node version raised to .`

This must never parse.

### Confirmed localization bug: every bare runtime file matches every runtime

Current root:

`src/localize/index.ts::localizeRuntimeRequirement`

For a bare runtime config path, the function emits a high-confidence site without checking which runtime the file declares.

This leads to findings such as `HS512256` being “localized” to:

- `.nvmrc` → `22.12.0`
- `.ruby-version` → `3.3.11`
- `.tool-versions` → `gitleaks 8.24.3`

all at high confidence.

The function also defaults an unrecognized runtime symbol to the Node declaration matcher.

### Confirmed compatibility bug: presence is treated as impact

Even a genuine runtime raise is not necessarily a local incompatibility.

Example:
- React/React DOM requirement: Node 18
- GitLab `.nvmrc`: Node 22.12.0

The repository already satisfies the target floor, so the runtime declaration does not need migration. It must not count as an impact site merely because the file exists.

### Existing code that should be reused

`src/rationale/runtime.ts` already contains runtime declaration and semver compatibility logic such as Node/Python declaration discovery and compatibility checking.

`src/rationale/maintenance.ts` already understands the difference between a compatible and incompatible runtime requirement.

Do not create a third independent runtime parser in the localizer.

### Required fix

Represent runtime changes structurally:

```ts
{
  kind: 'runtime-requirement',
  runtime: 'node',
  requirement: '>=18',
  sourceText: '...'
}
```

Rules:
1. Only classify as runtime when the phrase identifies a supported runtime and a parseable version/range.
2. Require at least one digit in parsed versions.
3. Generic “dropped support for X” where X is a feature/library/algorithm is not a runtime requirement.
4. Parse runtime-specific files:
   - `.nvmrc` → Node only
   - `.node-version` → Node only
   - `.ruby-version` → Ruby only
   - `.python-version` → Python only
   - `.tool-versions` → parse keys line-by-line
5. Do not default an unknown runtime to Node.
6. A site is impacted only when the declared runtime is incompatible or partially incompatible with the new requirement.
7. A declaration that already satisfies the requirement is context, not an impact site.

### Required regression cases

- Node 18 + `.nvmrc 22.12.0` → 0 impact.
- Node 24 + `.nvmrc 22.12.0` → `.nvmrc` is an impact.
- Node 24 must not match `.ruby-version`.
- `.tool-versions` line `gitleaks 8.24.3` must not match Node/Ruby.
- Ruby 3.2 + `.ruby-version 3.3.11` → 0 impact.
- `Dropped support for HS512256` → not runtime.
- `Dropped support for importing internal files from lib/` → not runtime.
- `Dropped support for Mongoid < 8` → not runtime.
- `Minimum Node version raised to .` → no finding.

### Findings likely worth retaining

Import-linked findings such as actual `@apollo/client` exports, Tiptap exports, and major Vue/Vue Router changes should be re-evaluated after the generic localization fixes. Do not suppress them merely because the recording contains other false positives.

**Disposition:** GitLab must be regenerated after runtime parsing/localization is fixed. Do not special-case the named packages.

---

## 3.4 Kubernetes — Go

**Coverage:** 545 checked, 280 candidates  
**Hard migration claims:** 0  
**Localized symbol sites:** 0 observed  
**Verdict:** no obvious false-positive claim in the recording.

Important clarification: Drift's Go parser marks `// indirect` requirements as transitive, and `directDependencies()` excludes `transitive`, so the large package count is not simply caused by reading `go.sum` or treating all `// indirect` entries as direct.

However, 280 candidates with no local impacts should be treated as a coverage signal to verify after shared fixes, not as proof that all upgrades are safe.

**Action for Codex:** no package-specific fix from this audit. Re-run and ensure Go surface comparison/gaps are represented accurately.

---

## 3.5 Deno — Cargo/Rust repository

**Coverage:** 74 checked, 32 candidates in the recording's final index  
**Hard migration claims:** 0  
**Primary defect:** manifest/project discovery pollution.

The recording discovers hundreds of fixture manifests under paths such as:

`tests/registry/npm/@denotest/.../<version>/package.json`

and additional `tests/testdata/.../package.json` manifests.

It creates package rows for synthetic fixture packages such as `@denotest/*`.

### Current root cause

`src/detect/nested.ts::discoverNestedProjects`

- recursively walks to depth 8;
- treats any recognized manifest outside a formal workspace member as an undeclared nested project;
- shares ignored-directory rules with source walking;
- does not distinguish fixtures/test registries from user-owned sibling projects.

### Why this matters

Even where the fixture candidates end as up to date, they:
- inflate “packages checked”;
- perform unnecessary registry work;
- can create synthetic upgrade rows;
- materially increase scan time;
- make recording coverage statistics misleading.

### Required fix

Do not simply add `tests` to a global source ignore list. Tests are legitimate source and can contain real dependency usage.

Instead, make **nested-project ownership discovery** fixture-aware.

A nested manifest should not automatically become a user project when it is beneath a fixture/test-registry subtree.

Recommended design:
- explicit configured scan roots always win;
- formal workspace declarations always win;
- undeclared auto-discovery should reject known fixture ownership paths (`fixtures`, `testdata`, test registries, versioned package snapshots, etc.);
- require additional project signals for ambiguous undeclared nested manifests where appropriate;
- keep legitimate sibling projects such as `extension/package.json` discoverable.

### Regression

Using Deno as fixture:
- `tests/registry/npm/**/package.json` must not become scan targets.
- `tests/testdata/**` package snapshots must not become user projects.
- a legitimate undeclared sibling `extension/package.json` must still be discovered.

---

## 3.6 Elasticsearch — Maven/Java

**Coverage:** 19 checked, 14 candidates  
**Hard migration claims:** 0  
**Localized symbol sites:** 0 observed  
**Verdict:** no obvious false positive found.

**Action:** no package-specific fix. Re-run after shared changes and preserve honest gaps/verification state.

---

## 3.7 ESPHome — Arduino/C++

**Coverage:** 25 checked, 8 candidates  
**Hard local migration candidates:** 2

- `dlms_parser 1.1.0 → 2.1.0`
- `FastLED 3.9.16 → 3.10.5`

### dlms_parser

The recording localizes `register_pattern` and `parse` to actual parser calls. These may be legitimate. This audit did not find enough evidence to classify them as false.

**Disposition:** keep as regression input, but re-evaluate after localizer fixes.

### FastLED — confirmed false positives

The recording asserts, among other things:

- `CLEDController.CLEDController` removed
- `UISlider.uint8_t` removed
- `size` changed kind
- `CLEDController.showLeds` removed

Problems:

1. Current FastLED documentation/source still exposes a `CLEDController` constructor and `size()`.
2. The `UISlider.uint8_t` finding is a parser artifact.
3. Derived `uint8_t` localization matches ordinary fundamental C++ template types in ESPHome.
4. The generic `size` finding matches ESPHome's own `size()` implementation.

### Current parser root

`src/evidence/surface/c-headers.ts`

The method recognizer can parse a conversion operator such as:

```cpp
operator uint8_t()
```

as though `uint8_t` were a member name.

Primitive filtering applies elsewhere but does not safely model this method shape.

### Required fix

- Model conversion operators as `operator T`, never as a member named `T`.
- Canonicalize namespace/class/member identity.
- Preserve declaration ownership through surface diff and localization.
- Do not derive fundamental C/C++ types as bare localizable member symbols.
- Add exact FastLED fixture coverage.

**Disposition:** FastLED result is substantially contaminated and must be regenerated.

---

## 3.8 RestSharp — NuGet/C#

**Coverage:** 34 checked, 27 candidates  
**Hard migration claims:** 0  
**Localized sites:** 0 observed  
**Verdict:** no obvious false positive found.

**Action:** no package-specific fix. Re-run after shared localizer/provider changes.

---

## 3.9 Guzzle — Packagist/PHP

**Coverage:** 10 checked, 7 candidates  
**Hard migration claims:** 0  
**Localized sites:** 0 observed  
**Verdict:** no obvious false positive found.

---

## 3.10 Phoenix — Hex/Elixir

**Coverage:** 44 checked, 18 candidates  
**Hard migration claims:** 0  
**Localized sites:** 0 observed  
**Verdict:** no obvious false positive found.

---

## 3.11 Dio — Pub/Dart

**Coverage:** 25 checked, 24 candidates  
**Hard `Migration required`:** 0  
**Soft local-impact candidate:** `web → 1.1.1`

The recording says approximately five local places use changed `web` APIs.

### Confirmed false-positive localization

A qualified upstream finding such as:

`TouchListWrapper.StateError`

is weakened to the leaf:

`StateError`

and matched against ordinary Dart core `StateError` usages in Dio's tests.

The same pattern occurs with `UnsupportedError`.

These local sites are unrelated to the qualified `web` package member.

### Root cause

`src/analyze/index.ts::symbolsFromFinding`

adds a bare leaf for qualified symbols unless that exact leaf appears in a static generic-name denylist.

This is structurally unsafe. There will always be another common leaf not yet in the list.

### Required fix

A qualified member may produce a bare-leaf **candidate**, but it may only become an actionable site when ownership is resolved.

Require one of:
- an import binding directly establishes that leaf from the relevant owner/module;
- a receiver path resolves to the dependency and the expected owner;
- a language-specific semantic index resolves the member.

Otherwise:
- keep it low/unverified or suppress it;
- never let it create a hard migration recommendation.

**Disposition:** `web` local impacts are false and should disappear after owner-aware localization.

---

## 3.12 TCA — Swift

**Coverage:** 17 checked, 13 candidates  
**Hard migration claims:** 0  
**Localized sites:** 0 observed  
**Verdict:** no obvious false positive found.

Representative targets include swift-case-paths, swift-concurrency-extras, swift-clocks, and swift-syntax.

---

## 3.13 FlexLayout — CocoaPods / Swift + SwiftPM

**Coverage:** 5 checked, 4 candidates  
**Primary defect:** wrong upgrade target.

### Confirmed false positive

Drift treats:

`facebook/yoga 3.2.1 → 2016.12.26`

as an upgrade.

`2016.12.26` is an old calendar-style tag. Semver interprets it as major `2016`, so a naive comparison incorrectly ranks it above `3.2.1`.

Yoga 3.2.1 is the relevant modern release line; this is not a valid upgrade.

### Current root cause

`src/upgrade/versions.ts`

For Swift:
1. GitHub tags are fetched.
2. Every parseable tag is normalized.
3. All parseable tags are placed in one semver ordering domain.
4. `semver.gt(tag, current)` is used.

A calendar tag that happens to parse as semver therefore beats a modern semantic version.

### Required fix

Introduce **version-family compatibility** before ordering tag-derived ecosystems.

At minimum:
- classify raw tag/version scheme before normalization;
- when current is ordinary semantic versioning, reject incompatible legacy calendar/date families;
- when current is itself calendar-versioned, compare against the calendar family;
- preserve `v` prefix stripping and ordinary semver normalization;
- never select a target solely because a different tag family has a larger numeric first component.

Regression:
- Yoga current `3.2.1` with tags including `2016.12.26` must remain up to date / choose only a genuine newer 3.x+ semantic release if one exists.

**Disposition:** FlexLayout recording has a wrong candidate and must be regenerated.

---

## 3.14 Cohttp — OPAM/OCaml

**Coverage:** 22 checked, 18 candidates  
**Hard local migration claims:** 0  
**Main result class:** insufficient evidence.

Examples include:
- `async`
- `base`
- `base64`
- `cmdliner`
- `conduit-async`
- `core`
- `core_unix`
- `cstruct`
- `eio`
- `ipaddr`

The recording repeatedly says:
- no computed OPAM API-surface diff;
- no source repository/release prose could be resolved;
- no OSV coverage for OPAM.

This is not a false positive. It is a **coverage gap**.

### Existing partial capability

`src/upgrade/versions.ts` can enumerate OPAM versions from the opam repository, so version lookup works.

The evidence layer still lacks enough OPAM source metadata/surface support.

### Recommended follow-up

P1/P2 rather than P0:
- parse OPAM package metadata (`dev-repo`, homepage/source fields) from `ocaml/opam-repository`;
- resolve the upstream repository and prose where possible;
- add an OCaml surface provider only if it can be done with trustworthy semantics.

Until then, these candidates must remain visibly **unchecked/insufficient evidence**, not “safe.”

---

## 3.15 Trantor — Conan/C++

**Coverage:** 3 checked, 3 candidates  
**Hard local migration claims:** all 3

- `gtest 1.10.0 → 1.18.0`
- `spdlog 1.12.0 → 1.17.0`
- `openssl 1.1.1 → 4.0.1`

All three contain confirmed false upstream removals.

### spdlog — confirmed false surface removals

Drift reports removed APIs including:
- `level`
- `name`
- `sinks`

and localizes `basic_cstring_view.c_str` through bare `c_str`.

In spdlog 1.17.0, `logger.h` still exposes:
- `level() const`
- `name() const`
- both `sinks()` overloads

Therefore the surface diff is factually wrong before localization even begins.

The localizer then compounds the problem:
- `level` matches Trantor's own parameter/local names;
- `c_str` matches unrelated C++ strings;
- generic leaf ownership is lost.

### GoogleTest — confirmed false surface removal

Drift reports `RUN_ALL_TESTS` removed and localizes real `RUN_ALL_TESTS()` calls.

GoogleTest still exposes `RUN_ALL_TESTS()`.

This is a surface-extraction/diff failure.

### OpenSSL — confirmed false surface removals

Drift reports local impact for:
- `SSL_get_error`
- `OPENSSL_cleanup`

Both exist in OpenSSL 4.0.1 headers.

Therefore the three localized OpenSSL sites are built on false upstream removals.

### Required fix

Treat the C/C++ provider as P0.

Do not patch these symbols individually.

The provider must:
- build canonical public-header identities;
- retain namespaces/classes/owners;
- survive declarations moving between public headers or inline definitions;
- correctly parse macros/functions/methods/constructors/conversion operators;
- compare callable identity and signatures rather than fragile textual placement;
- ignore implementation/private material that is not public API.

### Required exact regression fixtures

- spdlog `1.12.0 → 1.17.0`
  - `logger::level`, `logger::name`, `logger::sinks` not removed.
- GoogleTest `1.10.0 → 1.18.0`
  - `RUN_ALL_TESTS` not removed.
- OpenSSL `1.1.1 → 4.0.1`
  - `SSL_get_error`, `OPENSSL_cleanup` not removed.
- FastLED `3.9.16 → 3.10.5`
  - constructor/size/conversion-operator identities remain correct.

**Disposition:** Trantor recording is not reliable as an accuracy example until C/C++ surface extraction is fixed.

---

## 3.16 OBS Background Removal — vcpkg/C++

**Coverage:** 4 checked, 1 candidate  
**Candidate:** Astro `6.4.8 → 7.2.6`  
**Upstream breaking count:** non-zero  
**Local impacts:** 0  
**Verdict:** no obvious user-facing false positive found.

The upstream surface may still include questionable private/internal entries, but none are localized into OBS code in this recording.

Regenerate after C/C++ provider fixes because the same provider family is involved.

---

# 4. Root-cause backlog for Codex

## P0-001 — Canonicalize Python public surfaces

**Files**
- `src/evidence/surface/python.ts`
- relevant surface-provider tests

**Problem**
- sdist top-level version directory contaminates module names.
- docs/examples/config become “exports.”

**Implement**
- normalize archive root;
- identify importable package roots;
- restrict public surface to package code;
- canonical module/class/member IDs independent of release archive layout.

**Regression fixtures**
- itemloaders
- parsel
- Twisted docs example

**Do not**
- hardcode package names;
- strip arbitrary first path segment without verifying common archive root;
- simply add `docs` to one denylist and leave archive identity broken.

---

## P0-002 — Fix C/C++ public surface extraction

**Files**
- `src/evidence/surface/c-headers.ts`
- C/C++ provider utilities/tests

**Problem**
- surviving APIs reported removed;
- conversion operators misparsed;
- class/member identity is fragile.

**Implement**
- canonical namespace/class/member identity;
- correct callable/constructor/conversion-operator parsing;
- stable comparison across declaration relocation;
- public-header scope discipline.

**Regression fixtures**
- spdlog 1.12→1.17
- GoogleTest 1.10→1.18
- OpenSSL 1.1.1→4.0.1
- FastLED 3.9.16→3.10.5

---

## P0-003 — Stop unsafe owner loss during localization

**Files**
- `src/analyze/index.ts::symbolsFromFinding`
- `src/localize/index.ts`
- index/import-resolution code as necessary

**Problem**
Qualified members are expanded to bare leaves. A finite `GENERIC_LEAF_NAMES` set cannot guarantee correctness.

**Implement**
Represent symbols structurally, e.g.:

```ts
interface SymbolRef {
  full: string;
  namespace?: string;
  owner?: string;
  member?: string;
  kind?: 'module' | 'type' | 'function' | 'method' | 'field' | 'constructor';
}
```

A bare member is actionable only with owner/dependency evidence.

**Confidence rule**
- semantic/explicit owner resolution → high;
- credible dependency receiver but unresolved owner → medium;
- lexical bare leaf only → low/unverified and non-actionable.

**Regression**
- Dart `StateError` / `UnsupportedError`
- C++ `c_str`, `uint8_t`, `level`
- Python `failure`
- keep a real imported `Client.request` case working.

**Do not**
solve this by adding the currently observed names to `GENERIC_LEAF_NAMES`.

---

## P0-004 — Structured runtime-requirement parsing and localization

**Files**
- `src/analyze/rules.ts`
- `src/localize/index.ts`
- `src/rationale/runtime.ts`
- `src/rationale/maintenance.ts`
- related types/tests

**Problem**
- generic “dropped support” is treated as runtime.
- malformed `.` version accepted.
- runtime files cross-match.
- unknown runtime falls back to Node.
- compatible runtime declarations count as impacts.

**Implement**
One shared runtime model and compatibility path.

Do not keep separate regex semantics in analysis, maintenance, and localization.

**Required tests**
listed in GitLab section.

---

## P0-005 — Version-family-aware Swift tag selection

**Files**
- `src/upgrade/versions.ts`
- version tests

**Problem**
Calendar tags and semver tags share one ordering domain.

**Implement**
Classify compatible version families before sorting/selection.

**Regression**
Yoga 3.2.1 must never target 2016.12.26.

---

## P1-006 — Fixture-aware nested project discovery

**Files**
- `src/detect/nested.ts`
- discovery tests

**Problem**
Any nested manifest may become a project, including package-registry fixtures.

**Implement**
Separate “source traversal” policy from “auto-owned project” policy.

Formal workspaces and explicit roots always win. Auto-discovered nested projects need stronger ownership signals and fixture exclusions.

**Regression**
Deno test registry ignored; legitimate sibling extension discovered.

---

## P1-007 — Do not let weak local matches force “Migration required”

**Files**
- `src/rationale/assess.ts`
- `src/upgrade/severity.ts`
- confidence/localization plumbing

**Current problem**
`assessUpgrade()` uses `impactSites.length` to decide that the repository is affected, regardless of local-site confidence.

If any impacted breaking change is in `NEEDS_A_DECISION`, the recommendation becomes:

`manual-migration-required`

The UI label is:

`Migration required`

`severity.ts` hedges medium/low sites in one sentence (“May affect”), but the package recommendation can still be an imperative migration verdict.

**Implement**
Recommendation must account for local impact confidence/resolution.

Suggested policy:
- failed isolated deep verification → definitely affected;
- at least one high-confidence semantically resolved local site → affected/actionable;
- medium/low-only predictions → `review-required` / `possible-impact` semantics, not `manual-migration-required`;
- never convert lexical-only evidence into an imperative migration.

This is defense in depth. P0-003 still must remove the false sites themselves.

---

## P1-008 — Public API scope invariants for every surface provider

Every provider should explicitly answer:

> “What is public consumer API?”

Do not count:
- docs callbacks;
- examples;
- tests;
- internal/private headers;
- archive layout names;
- generated helper artifacts

unless the ecosystem genuinely publishes them as consumer API.

Add provider-level contract tests.

---

## P1/P2-009 — OPAM evidence coverage

**Files**
- registry/source resolution
- OPAM ecosystem provider

Resolve upstream source metadata from opam package definitions.

Do not weaken “insufficient evidence” just to make the recording look fuller.

---

# 5. Cross-cutting recording validation gate

After implementing the root fixes, add a validation step to the recording refresh workflow.

Suggested script:

`scripts/validate-recordings.mjs`

It should fail regeneration/CI on invariants such as:

1. **No incompatible version-family “upgrade”.**
   - Selected target must be a legitimate successor of current in the ecosystem's version scheme.

2. **No extracted archive root in canonical Python API IDs.**
   - A symbol must not begin with `<distribution>-<version>.`.

3. **No Python docs/example symbol presented as package export.**

4. **Runtime requirement is structured and parseable.**
   - No `Minimum Node version raised to .`.
   - Runtime symbol must be a known runtime.

5. **Runtime impact requires incompatibility.**
   - A Node 18 floor must not flag a Node 22 declaration.

6. **Runtime config ownership must match.**
   - Node finding cannot flag `.ruby-version`.
   - Ruby finding cannot flag `.nvmrc`.
   - `.tool-versions` must match only the relevant key.

7. **Qualified member cannot become high-confidence bare lexical match without ownership evidence.**

8. **Primitive/core language symbols derived from a member cannot become standalone local evidence.**

9. **Known regression symbols survive target surface.**
   - spdlog `name/level/sinks`
   - OpenSSL `SSL_get_error/OPENSSL_cleanup`
   - GoogleTest `RUN_ALL_TESTS`

10. **Fixture project count guard.**
    - Deno test registry manifests must not enter the project target set.

This validator is not a replacement for unit tests. It is a final corpus-level tripwire.

---

# 6. Recommended implementation order for Codex

Use one PR, but implement in atomic commits.

### Commit 1 — Regression fixtures only
Add failing tests for:
- Python archive root + docs
- spdlog/OpenSSL/gtest/FastLED
- qualified-leaf collisions
- runtime parsing/localization/compatibility
- Yoga tag family
- Deno nested fixture manifests

Do not alter production behavior yet.

### Commit 2 — Python surface normalization
Fix P0-001 and make its tests pass.

### Commit 3 — Runtime model
Fix P0-004 and make GitLab runtime tests pass.

### Commit 4 — Owner-aware symbol/localization model
Fix P0-003. Keep generic-name denylist only as defense in depth.

### Commit 5 — C/C++ provider
Fix P0-002 using exact upstream fixture coverage.

### Commit 6 — Swift tag version family
Fix P0-005.

### Commit 7 — Nested discovery
Fix P1-006.

### Commit 8 — Recommendation/confidence guardrail
Fix P1-007 so weak-only impact cannot say “Migration required.”

### Commit 9 — Corpus validator + regenerated recordings
- run all tests;
- run recording refresh;
- run recording validator;
- inspect before/after diff;
- ensure no new ecosystem regression.

OPAM source-coverage work may be a separate PR if it materially expands scope. It is not required to fix the confirmed false positives.

---

# 7. Codex prompt / execution contract

Use this section as the direct implementation prompt.

## Goal

Fix all confirmed systemic false-positive classes found in the 2026-08-25 Drift recording audit. Do not patch individual packages. Implement generalized correctness fixes, regression tests, regenerate all recordings, and open one PR.

## Repository baseline

Start from current `main`. The audit baseline was:

`a980fa757a512bf806b6b0b7d124a7b3417af2c6`

If main moved, first determine whether any audit item is already fixed. Preserve newer correct changes; do not regress them.

## Mandatory root issues

1. Python sdist/archive-root and public-package surface identity.
2. C/C++ false surface removals and conversion-operator/member parsing.
3. Qualified member → unsafe bare-leaf localization.
4. Runtime prose misclassification, config cross-matching, and lack of compatibility checking.
5. Swift git-tag incompatible version-family ordering.
6. Nested fixture manifest discovery.
7. Weak-only local impacts forcing “Migration required.”

## Exact regression examples

### Python
- itemloaders 1.0.1→1.4.0: `TakeFirst`, `MapCompose`, `Compose` survive.
- parsel 1.5.0→1.11.0: `Selector` canonical identity survives; `docs.conf.*` is not public API.
- Twisted docs `pbechoclient.failure` is not public API and never matches `twisted.python.failure`.

### C/C++
- spdlog 1.12→1.17: `logger::level`, `logger::name`, `logger::sinks` survive.
- GoogleTest 1.10→1.18: `RUN_ALL_TESTS` survives.
- OpenSSL 1.1.1→4.0.1: `SSL_get_error`, `OPENSSL_cleanup` survive.
- FastLED: conversion `operator uint8_t()` must not create member `uint8_t`.

### Localization
- `basic_cstring_view.c_str` must not match unrelated `.c_str()`.
- `TouchListWrapper.StateError` must not match Dart core `StateError`.
- `UISlider.uint8_t` must not match ordinary `uint8_t`.
- a real owner-resolved member use must still localize.

### Runtime
- Node18 with `.nvmrc 22.12.0` → no impact.
- Node24 with `.nvmrc 22.12.0` → impact.
- Node finding never matches `.ruby-version`.
- `.tool-versions` key must be parsed.
- HS512256 / Mongoid / HTML comments / importing lib internals are not runtime changes.
- `.` is not a valid parsed runtime version.

### Versions
- Yoga 3.2.1 must not “upgrade” to 2016.12.26.

### Discovery
- Deno `tests/registry/npm/**` fixture manifests are not projects.
- legitimate undeclared sibling project remains discoverable.

## Design constraints

- No package-specific exceptions.
- No hardcoded symbol patches.
- No “fix” consisting only of adding names to `GENERIC_LEAF_NAMES`.
- Preserve localization recall where ownership can be established.
- Prefer an honest unchecked/low-confidence result over a fabricated confident impact.
- Do not call an upgrade safe merely because evidence collection failed.
- CLI, VS Code extension, Action, and website recordings must continue to consume the same core behavior.

## Verification before PR

Run the complete test suite plus ecosystem/provider tests.

Regenerate every recording.

Then manually/assertion-check at minimum:
- Scrapy no longer contains versioned sdist-root API IDs or Twisted docs callback impacts.
- Deno no longer discovers registry fixtures as user projects.
- Dio `web` no longer flags core `StateError`/`UnsupportedError`.
- ESPHome FastLED no longer emits `UISlider.uint8_t` or false surviving-method removals.
- FlexLayout no longer offers Yoga 2016.12.26.
- Trantor no longer reports surviving spdlog/gtest/OpenSSL APIs removed.
- GitLab no longer maps arbitrary “dropped support” prose to runtime files, and already-compatible runtime declarations are not impact sites.
- No medium/low lexical-only result can headline as “Migration required.”

## PR description

Include:
- root causes, not only symptoms;
- exact regression fixtures added;
- recording before/after changes;
- any remaining ecosystem coverage gaps;
- explicit note if OPAM surface/source coverage remains incomplete.

---

# 8. Definition of done

The PR is done only when all of the following are true:

- [ ] All confirmed false-positive reproductions have failing-before/passing-after tests.
- [ ] No package-specific suppressions were introduced.
- [ ] Python canonical surfaces are archive-layout independent.
- [ ] C/C++ known surviving APIs are no longer reported removed.
- [ ] Qualified-member localization preserves owner semantics.
- [ ] Runtime requirements are structured, runtime-specific, and compatibility-checked.
- [ ] Yoga/date-tag regression is fixed generically.
- [ ] Deno fixture manifests are excluded from auto project discovery.
- [ ] Weak-only impact cannot produce an imperative migration verdict.
- [ ] Every recording has been regenerated from the fixed engine.
- [ ] Recording validator passes.
- [ ] Remaining “insufficient evidence” cases are explicitly labeled as such.
- [ ] CLI/extension/Action/site behavior remains consistent because fixes live in shared core.

---

# 9. Priority summary

### Merge blocker / P0
- Python surface identity
- C/C++ surface correctness
- qualified-member owner loss
- runtime prose + runtime localization
- Swift tag family selection

### High priority / P1
- nested fixture discovery
- confidence/recommendation guardrail
- public API scope contracts
- corpus validation gate

### Follow-up / P2
- OPAM source/API evidence coverage

---

## Final audit conclusion

The recordings reveal a common architectural theme: Drift is frequently very good at finding *text that resembles* an upstream change, but a few layers still lose the semantic identity needed to prove that the upstream thing and the repository thing are the same thing.

The fix should therefore move Drift toward stronger canonical identities:

**package → module/namespace → owner/type → member → signature**

and keep that identity intact through:

**surface extraction → diff → BreakingChange → localization → confidence → recommendation**

Whenever that chain cannot be established, Drift should surface uncertainty rather than manufacture certainty.

That single principle addresses the Python archive-root bug, C/C++ member errors, Dart/C++ bare-leaf collisions, Twisted `failure`, and a large portion of the GitLab runtime noise without accumulating package-specific logic.
