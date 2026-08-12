# Testing Drift on a real repository

Four ways to try it, in ascending order of commitment. Start at 1.

> **Automated coverage:** the walkthrough below is one manual example (`got`,
> npm). `test/real-repo-recordings.test.ts` covers all sixteen supported
> ecosystems — it
> replays the real captured runs behind the [site's real-run
> demos](../site/src/data/), one per supported ecosystem, and checks that
> `severityOf`'s verdict agrees with the recorded counts, that every breaking
> change carries evidence, and that the reported impact counts are internally
> consistent. Those recordings come from `site/scripts/capture.mjs` against
> real, large, unrelated-to-Drift repositories (gitlab, kubernetes, deno,
> scrapy, and twelve others) — they run automatically in CI as part of `npm
> test`, no network access required.

> **Note:** Drift is not published to the GitHub Marketplace yet, so
> `uses: trydrift/drift@v0` will not resolve. Until it is, reference the action
> from your own fork or a local path — both covered below.

---

## 1 · Local CLI (no permissions, no setup)

The fastest real test. Runs the entire pipeline against a real repository and
prints the report. Creates nothing.

```bash
# From the Drift repo
npm ci && npm run build

# Point it at any repository you have locally
cd ~/code/your-project
GITHUB_TOKEN=$(gh auth token) node /path/to/Drift/dist/cli.js analyze
```

By default it diffs `HEAD^..HEAD`. To target a specific dependency bump:

```bash
node /path/to/Drift/dist/cli.js analyze \
  --before <sha-before-the-bump> \
  --after  <sha-after-the-bump>
```

### Reproducing the validated example

This is the exact run from the README, against a real upstream bump:

```bash
git clone https://github.com/sindresorhus/got /tmp/got
cd /tmp/got && git checkout 1234062d21c0

GITHUB_TOKEN=$(gh auth token) node /path/to/Drift/dist/cli.js analyze
```

Expect: 2 breaking changes (ESM-only, Node >=14.16), 9 impact sites across
6 files, and a guardrail blocking dispatch because one site is in
`.github/workflows/main.yml`.

`--json` emits the plan as structured data instead of markdown.

---

## 2 · Simulate the Action locally

Runs the real bundled action, exactly as GitHub would, without pushing
anything.

```bash
cd /path/to/Drift
npm run build:action

REPO=/tmp/got                      # a local clone at the bump commit
BEFORE=$(git -C $REPO rev-parse HEAD^)
AFTER=$(git -C $REPO rev-parse HEAD)

cat > /tmp/event.json <<EOF
{
  "ref": "refs/heads/main",
  "before": "$BEFORE",
  "after": "$AFTER",
  "repository": { "full_name": "sindresorhus/got", "default_branch": "main" }
}
EOF

GITHUB_ACTIONS=true \
GITHUB_EVENT_PATH=/tmp/event.json \
GITHUB_WORKSPACE=$REPO \
GITHUB_OUTPUT=/tmp/gh_output.txt \
GITHUB_STEP_SUMMARY=/tmp/gh_summary.md \
env "INPUT_REPO-TOKEN=$(gh auth token)" "INPUT_DRY-RUN=true" \
  node action/index.cjs

cat /tmp/gh_output.txt      # the step outputs
cat /tmp/gh_summary.md      # the full report, as it appears in the Actions UI
```

> Input names are passed as `INPUT_<NAME>` with **hyphens preserved** —
> `dry-run` becomes `INPUT_DRY-RUN`, not `INPUT_DRY_RUN`. Getting this wrong
> silently disables the input.

---

## 3 · Run it as a real Action in a sandbox repo

The first test that actually writes to GitHub. Use a scratch repo, not
production.

### 3a. Publish your build

Actions do not run `npm install`, so the bundled entrypoint must be committed.

```bash
cd /path/to/Drift
npm run build:all          # library + committed action bundle
git add action/ && git commit -m "build: action bundle"
git push origin main       # to YOUR fork
```

### 3b. Create a sandbox repo with a real breaking upgrade

```bash
mkdir drift-sandbox && cd drift-sandbox && git init

# A dependency with a genuine, well-documented breaking change
npm init -y
npm pkg set dependencies.chalk="4.1.2"
cat > index.js <<'EOF'
const chalk = require('chalk');
console.log(chalk.blue('hello'));
EOF
git add -A && git commit -m "initial: chalk 4"
```

Push it to GitHub, then in a second commit make the breaking bump:

```bash
npm pkg set dependencies.chalk="5.3.0"   # chalk 5 is ESM-only
git commit -am "chore: bump chalk to 5"
git push
```

`chalk@5` is a good test case: it is ESM-only, which breaks the `require()`
above without renaming a single export.

### 3c. Add the workflow

`.github/workflows/drift.yml` in the sandbox repo:

```yaml
name: Drift
on:
  push:
    branches: [main]
    paths: ['**/package.json']
  workflow_dispatch:
  issue_comment:
    types: [created]

jobs:
  drift:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      issues: write
      pull-requests: write
      checks: write
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 2
      - uses: YOUR-USERNAME/Drift@main      # your fork
        with:
          repo-token: ${{ secrets.GITHUB_TOKEN }}
          # Omit copilot-token for the first run — see below
```

**Run it in the default `approve` mode, without `copilot-token`, first.** Drift
will analyse, find the ESM break, and file an approval issue. Nothing gets
edited. Read that issue before granting anything more — a Copilot token is
only needed later, for fixes Drift can't resolve itself.

### 3d. Then add Copilot

Create a fine-grained PAT with **Agent tasks: read and write** (the only
permission the endpoint checks), save it as the secret `DRIFT_COPILOT_TOKEN`,
and add:

```yaml
          copilot-token: ${{ secrets.DRIFT_COPILOT_TOKEN }}
```

Comment `/drift apply` on the approval issue. Drift creates the branch and
hands Copilot the plan.

Requires an active Copilot subscription with the coding agent enabled — the
API rejects `GITHUB_TOKEN` and App installation tokens, because Copilot is
billed per seat. See [copilot-integration.md](copilot-integration.md).

---

## 4 · Enable it on a real repository

Once step 3 behaves the way you expect:

1. Copy [`examples/workflows/drift.yml`](../examples/workflows/drift.yml).
2. Add `DRIFT_COPILOT_TOKEN`.
3. **Leave `mode: approve`** (the default). Read several real plans.
4. Only then consider `mode: auto` with `maxAutoRisk: low`.

When you move to a real repository, keep `mode: approve` until the plans have
become routine enough that you're comfortable changing the policy.

---

## Good test cases

Dependencies with real, well-documented breaking changes:

| Package | Bump | What breaks |
| --- | --- | --- |
| `chalk` | 4 → 5 | ESM-only; every `require()` breaks |
| `node-fetch` | 2 → 3 | ESM-only |
| `@szmarczak/http-timer` | 4 → 5 | ESM-only + Node >=14.16 |
| `express` | 4 → 5 | Removed APIs, changed middleware signatures |
| `commander` | 8 → 9 | Node >=12.20, renamed methods |

The ESM ones are the most instructive: they break consumers without renaming
anything, so they show why symbol-diffing alone is insufficient.

---

## Troubleshooting

**"No dependency changes detected"** — Drift diffs against the previous commit.
Confirm `fetch-depth: 2` is set, and that the manifest actually changed in the
commit being analysed.

**"No affected code found"** — often correct: the bump genuinely doesn't touch
you. Verify with `--json` and check `evidence` — if the only source is
`semver-heuristic`, Drift found no changelog or API diff to reason from.

**Action fails with `Cannot find module`** — the committed bundle is stale or
missing. Run `npm run build:action` and commit `action/index.cjs`.

**Copilot dispatch returns 403** — almost always a token type problem. It must
be a *user* PAT, not `GITHUB_TOKEN` and not an App installation token.

**Everything is blocked by a guardrail** — that is the default posture working.
Read the blocker text; it names the specific setting in `drift.yml`.
