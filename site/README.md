# The Drift landing page

A static site, deployed to GitHub Pages, whose centrepiece is a replay of real
Drift runs against real open source repositories.

## Why it works the way it does

Drift clones repositories, shells out to package managers and calls registries.
None of that can happen in a browser, so the obvious options were a video, a
hand-written animation, or nothing. All three have the same problem: a visitor
has no way to tell a demo from a mock-up, and a tool whose entire pitch is
*don't take our word for it, here is the evidence* cannot afford to open with
something unverifiable.

So the demo is a recording. `scripts/capture.mjs` runs the real pipeline against
a real project and writes out every dependency, every version, every finding, and
every progress event with the millisecond it actually happened at. The browser
replays that timeline. The commit each run was taken against is printed under
the panel and linked, so anyone can go and check.

The timestamps are the part that is easy to underestimate. A designed animation
paces itself evenly, because that is how work feels in the imagination. Real
work does not: one package resolves instantly from a warm registry response and
the next stalls four seconds behind a changelog fetch. Keeping that unevenness
is most of what makes the panel read as a tool doing something rather than a
progress bar being polite. Gaps are capped at 900ms so nobody stares at a frozen
panel, and the whole thing plays at 3× — both stated on the page, next to the
real duration.

## Recording new samples

```bash
npm run build --prefix ..     # capture imports the compiled core from ../dist
npm run capture               # every target
npm run capture -- deno       # one, by id
```

Targets are declared at the top of `scripts/capture.mjs`. Output lands in
`src/data/*.json` and is committed — the site is static, and a build must not
depend on cloning six repositories.

`GITHUB_TOKEN` is optional and only raises the public API rate limit; without
one, expect more packages to come back as *not verified*, which the recording
will faithfully show.

Two things the capture script does deliberately:

- **Scrubs paths.** Progress details name whatever directory the run was given,
  which is a scratch folder on somebody's laptop. They are rewritten to the
  repository's own name.
- **Slims the output.** A full `UpgradeCandidate` carries the entire plan and
  every version ever published — megabytes per package, almost none of it on
  screen. Only the fields the panel renders are kept.

## Verdicts come from Drift, not from here

`src/lib/severity.ts` is a generated copy of `src/upgrade/severity.ts` from the
core package, refreshed by `scripts/sync-severity.mjs` before every build and
dev start.

This is not incidental. The first version of this page reimplemented the verdict
rules and got them wrong in the way that matters most: it collapsed *a hundred
upstream breaking changes, none of which touch your code* into a generic pass,
which is the single most valuable thing Drift has to say. It also ignored the
rationale's own conclusion, so packages whose API had been compared symbol by
symbol were labelled "could not verify" while their own summary said they were
fine. Copying the module means the site reaches exactly the verdict the
extension reaches, because it runs the same function.

The copy exists because a TypeScript path alias into `../src` type-checks but
does not bundle — Turbopack will not resolve across the project root. It is
committed so a fresh checkout type-checks, and regenerated before anything is
bundled, so a stale copy has a lifetime of zero builds.

## Local development

```bash
npm install
npm run dev        # http://localhost:3000
npm run build      # static export to out/
npm run typecheck
```

## Deployment

`.github/workflows/pages.yml` builds and publishes on a push to `main` that
touched `site/`, and on manual dispatch.

One-time setup, in **Settings → Pages**, set **Source** to **GitHub Actions**.
Nothing else is required — `actions/configure-pages` reports the correct base
path for this repository, including when a custom domain removes it, and the
build reads it from `NEXT_PUBLIC_BASE_PATH`. Hardcoding it is the classic way to
ship a project page that loads no CSS while working perfectly in local dev.
