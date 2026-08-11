# Contributing to Drift

## Before you start

For anything beyond a small fix, open an issue first — especially for a new
ecosystem provider or a change to guardrail defaults. Those touch the trust
model documented in [docs/trust-and-safety.md](docs/trust-and-safety.md) and
are worth agreeing on before you write code.

## Setup

```bash
npm install
npm run build
npm test
```

`npm test` builds and runs the full suite (`node --test`). Most stages —
detect, evidence, localize, plan — are pure functions over recorded fixtures
and need no network access or installed toolchains.

## Before opening a PR

```bash
npm run typecheck
npm test
npm run check:docs        # docs/support.md must match the generated data
npm run verify:workflow   # examples/workflows/drift.yml must match the generator
```

If you touched `action.yml` or `scripts/build-action.mjs`, also run:

```bash
npm run build:action
npm run verify:action-bundle
```

and commit the resulting `action/index.cjs` — Actions don't run `npm install`,
so the bundle has to be committed.

## Reporting incorrect analysis

If Drift reported a false positive, a false negative, or wrong evidence, use
the "Incorrect analysis" issue template rather than the generic bug template —
it asks for the ecosystem, package, version pair, and what Drift got wrong,
which is what actually lets us fix the underlying rule.

## Code style

No linter config beyond what's in `package.json` — match the surrounding
file. Prefer the existing patterns in a stage's directory (`src/<stage>/`)
over introducing a new one.

## License

By contributing, you agree that your contributions will be licensed under the
terms in [LICENSE](LICENSE).
