# Deployment

Three ways to run Drift. They share the same pipeline and differ only in what
surrounds it.

| | Infra | Localization | Multi-repo | Recommended for |
| --- | --- | --- | --- | --- |
| **GitHub Action** | None | Full | Per repo | **Almost everyone** |
| **CLI** | None | Full | Manual | Evaluation, local checks |
| **Webhook server** | You host | ✗ | Yes | Self-hosted multi-repo |

---

## 1 · GitHub Action (recommended)

Nothing to host, nothing stored, and the Copilot token never leaves your
repository. This is the deployment Drift is designed around — see
[copilot-integration.md](copilot-integration.md) for why.

### Setup

1. Copy [`examples/workflows/drift.yml`](../examples/workflows/drift.yml) to
   `.github/workflows/drift.yml`.
2. Run it in the default `approve` mode and read the first few reports.
3. Optionally create a fine-grained PAT with **Agent tasks: read and write** —
   the only permission the Agent Tasks endpoint checks — and save it as the
   secret `DRIFT_COPILOT_TOKEN`, if you want Copilot to handle commits Drift
   can't resolve deterministically.
4. Optionally copy [`examples/drift.yml`](../examples/drift.yml) to
   `.github/drift.yml`.

### Minimal workflow

```yaml
name: Drift
on:
  push:
    branches: [main]
    paths: ['**/package.json', '**/package-lock.json']
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
          fetch-depth: 2   # Drift diffs against the previous commit
          # Drift commits through the GitHub API, not a local `git push`, and
          # verification installs each candidate upgrade's own untrusted code
          # in a throwaway worktree — see docs/trust-and-safety.md. Neither
          # needs a push-capable credential left in the runner's git config.
          persist-credentials: false
      - uses: trydrift/drift@v0
        with:
          copilot-token: ${{ secrets.DRIFT_COPILOT_TOKEN }}
```

`fetch-depth: 2` matters. Without the previous commit there is no manifest diff,
and without a diff there is nothing to analyse.

### Inputs

| Input | Default | |
| --- | --- | --- |
| `repo-token` | `${{ github.token }}` | Repository operations |
| `copilot-token` | — | **User-scoped**. Only needed for commits Drift can't resolve deterministically or via a validated fix plan |
| `mode` | from `drift.yml` | Overrides the committed config |
| `dry-run` | `false` | Analyse without writing |
| `config-path` | `.github/drift.yml` | |
| `log-level` | `info` | |

### Outputs

`status` (`dispatched` \| `skipped` \| `blocked` \| `failed`), `summary`,
`branch`, `pull-request-url`, `approval-issue`.

### Exit codes

`0` for everything except a genuine failure — **including blocked runs**. Drift
correctly asking a human is a successful outcome; failing the workflow there
would train people to ignore it.

### Monorepos

Drift localizes findings per workspace member already — a bump in
`packages/api/package.json` is scoped to `packages/api`, read from
`workspaces`/`pnpm-workspace.yaml`, Cargo `[workspace]`, `go.work`, Maven
`<modules>`, or Gradle `settings.gradle[.kts]`. What isn't supported is
non-literal member globs (brace expansion, mid-segment wildcards); see
[architecture.md](architecture.md#known-limitations). To run Drift as fully
separate jobs per package anyway, run a matrix and point `config-path` at
per-package configs.

---

## 2 · CLI

```bash
npm install -g @usedrift/cli
drift analyze
```

`analyze` is **read-only by construction** — no token is passed through to
dispatch and dry-run is forced. There is no code path in it that creates a
branch, an issue, or an agent task. No token or account is needed; set
`GITHUB_TOKEN` only if you hit GitHub's anonymous API rate limit.

```
drift analyze --repo owner/name --before <sha> --after <sha> --dir ./path --json
```

`drift outdated` scans every direct dependency for a newer version — same
read-only rules for your checkout and GitHub. Verification (on by default)
does install each candidate and run your project's own checks in a
disposable worktree before reporting it, never in the checkout itself — see
[trust-and-safety.md](trust-and-safety.md#a-compromised-candidate-dependency-during-verification).
When you're ready to act:

```
drift fix   # analyse, apply what it can, push a branch, and open a pull request
drift pr    # push the current branch and open a pull request
```

`fix` and `pr` need GitHub write access to push and open a pull request.

Useful for:

- Evaluating Drift before granting any write permission
- Checking a dependency bump locally before pushing
- Piping `--json` into your own tooling

`drift action` and `drift serve` are the entrypoints the GitHub Action and the
webhook server run internally — see below.

---

## 3 · Webhook server (self-hosted)

The "App that watches your repos" experience, self-hosted and single-tenant.

Requires **Node 22.6 or newer** — the delivery queue uses `node:sqlite` from the
standard library. Drift says so at startup rather than failing later.

```bash
export GITHUB_WEBHOOK_SECRET=...   # required — Drift refuses to run without it
export GITHUB_TOKEN=...
export DRIFT_COPILOT_TOKEN=...     # user-scoped
export PORT=3000
export DRIFT_QUEUE_PATH=/data/queue.db   # default: .drift/queue.db

npm run build && npm run serve
```

Point a GitHub App or repository webhook at `POST /webhook` for **push** and
**issue_comment** events. `GET /health` reports liveness and queue depth.

### The delivery queue

Every verified delivery is written to disk **before** Drift answers `202`. That
ordering is the whole point: GitHub treats a `202` as final and will not resend,
so acknowledging work that exists only in memory means losing it on the next
restart — silently, with the delivery marked successful in GitHub's UI.

| Setting | Default | Meaning |
| --- | --- | --- |
| `DRIFT_QUEUE` | `sqlite` | `sqlite` (durable) or `memory` (not durable) |
| `DRIFT_QUEUE_PATH` | `.drift/queue.db` | Database file. Put it on a persistent volume. |

Deliveries are keyed by GitHub's `X-GitHub-Delivery` header under a uniqueness
constraint, so a redelivery is acknowledged without being processed twice. A job
interrupted by a restart is returned to the queue at startup, and failures are
retried with bounded exponential backoff before being marked terminal.

`DRIFT_QUEUE=memory` is available for smoke tests. It logs a warning on every
start, because a runner that quietly drops work on restart is the failure the
queue exists to remove.

`GET /health` returns counts only — queue depth, in-flight, and permanently
failed — never payloads, repository names, or delivery IDs:

```json
{ "status": "ok", "queue": { "queued": 0, "running": 1, "failed": 0, "oldestPendingAgeMs": 812 } }
```

`status` becomes `degraded` when any delivery has failed permanently.

### Three honest limitations

**No checkout, so no localization.** The server sees webhooks, not a working
tree. It detects changes and gathers evidence, but cannot search for affected
code without cloning. It warns at runtime rather than silently reporting zero
impact sites.

**Single-tenant.** The Copilot API needs a user-scoped token. Serving multiple
users would mean storing one token each — the credential database this MVP is
designed not to need.

**Single-node.** The queue is durable across restarts of one process, not shared
between replicas. Two runners against one database file is not supported.

All three are properties of the deployment model, not bugs. The Action has none
of them.

### Deploying it

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist ./dist
ENV DRIFT_QUEUE_PATH=/data/queue.db
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "dist/runners/webhook.js"]
```

Runs anywhere that speaks HTTP — Fly, Railway, Cloud Run, a VM — with two
requirements that follow from the queue: give it a **persistent volume** for the
database, and run **one instance**. A platform that restarts the container on
deploy is fine; one that runs several replicas behind a load balancer is not.

Drift drains the delivery in flight on `SIGTERM` before exiting, so an ordinary
deploy costs nothing. A hard kill is safe too — the job is recovered and retried
on the next start.

---

## Choosing

**Use the Action** unless you have a specific reason not to. It is the only
deployment with full localization, zero infrastructure, and no credential
custody.

**Use the CLI** to evaluate Drift, or in a pre-push hook.

**Use the webhook server** when you want central multi-repo listening, control
your own infrastructure, and accept that detailed localization requires the
Action.

They compose: run the webhook server for org-wide visibility and the Action on
the repositories where you want fixes dispatched.

---

## Publishing a release

Release publishing uses OIDC on both registries — there is no npm or VS Code
Marketplace token stored in this repository, and there should never be one.
The workflow keeps validation and publication in separate trust domains:

- `validate` has read-only repository access and no OIDC permission. It runs
  every dependency install, test, eval, and build, then creates, tests, and
  uploads the exact npm tarball and VSIX together with their checksums.
- `publish` starts only after `validate` succeeds. It has the OIDC and
  repository write permissions required for publishing, downloads and verifies
  those artifacts, and publishes them unchanged. It does not checkout the
  repository, install repository dependencies, rebuild, or run project code.

This makes the artifact tested in the unprivileged job the artifact published
by the privileged job. Short-lived publishing authority is unavailable while
repository and dependency code executes.

Two trust relationships have to exist before the first tag, and both are
account-level settings only a maintainer with the right access can create —
`release.yml` cannot create them itself:

| Prerequisite | Where | Why |
| --- | --- | --- |
| The repository is **public** | GitHub → Settings → General | `uses: trydrift/drift@v0` cannot resolve from a private repository, and the Marketplace listing links to it |
| npm **Trusted Publisher** configured for `@usedrift/cli` | [npmjs.com](https://www.npmjs.com) → package → Settings → Trusted Publisher | Lets `npm publish` succeed with no token, authenticated as GitHub owner `trydrift`, repository `drift`, workflow `release.yml`. **The package must already exist** — see bootstrap below |
| VS Code Marketplace **Trusted Publisher** configured for publisher `drift` | Marketplace publisher management (`vsce` docs) | Lets `vsce publish --oidc` succeed with no PAT, trusting `trydrift/drift` → `.github/workflows/release.yml` |
| **GitHub Pages enabled**, source **GitHub Actions** | GitHub → Settings → Pages | `pages.yml` deploys the site with `actions/deploy-pages`, which fails outright if the source is still set to a branch |

### The npm bootstrap problem

npm Trusted Publishing can only be configured for a package that already
exists, and `@usedrift/cli` doesn't yet. This is a one-time, manual prerelease,
external step — never automated into `release.yml` — before Trusted Publishing
can be turned on. Automated tag-driven releases accept exact stable `vX.Y.Z`
tags only:

1. Confirm every version (`package.json`, `package-lock.json`,
   `extension/package.json`, `extension/package-lock.json`) is `0.1.0` — run
   `npm run release:version` to check.
2. From a trusted maintainer machine, publish a **prerelease bootstrap
   version** manually — not `0.1.0` itself, because npm versions are
   immutable and publishing `0.1.0` here would leave the automated release
   unable to publish stable `0.1.0` later:
   ```bash
   npm version 0.1.0-beta.0 --no-git-tag-version
   npm publish --access public
   git checkout -- package.json package-lock.json   # restore 0.1.0
   ```
3. On [npmjs.com](https://www.npmjs.com), open `@usedrift/cli` → Settings →
   Trusted Publisher, and configure GitHub owner `trydrift`, repository
   `drift`, workflow `release.yml`.
4. Confirm the repository versions are still (or once again) `0.1.0`
   everywhere.
5. Tag and push as below. `release.yml` publishes stable `0.1.0` through
   OIDC — no token involved.

The VS Code Marketplace has no equivalent bootstrap problem: the `drift`
publisher and `drift.drift` extension id can be registered ahead of the first
release, and its Trusted Publisher trust can be configured before anything is
ever published.

### Releasing

Once both Trusted Publisher relationships exist:

```bash
npm run release:check   # local mirror of the validation phase; no tag needed yet
git tag v0.1.0
git push origin v0.1.0
```

`release.yml` rejects prerelease and malformed tags, then validates the stable
tag against every manifest's version (see `scripts/check-release-version.mjs`).
Its unprivileged `validate` job runs the same validation phase
`npm run release:check` runs locally and uploads the tested npm tarball and
VSIX. Only after that succeeds does the privileged `publish` job download and
publish those exact artifacts, create the GitHub Release with the same VSIX
attached, and move the floating **`v0`** tag onto `v0.1.0` so
`uses: trydrift/drift@v0` resolves to it. A prerelease tag, version mismatch,
or any validation failure stops the workflow before anything is published.

Listing the Action on the GitHub Marketplace is a separate, one-time manual
step from the repository's own "Draft a release" / Marketplace tooling — it
does not affect whether `uses: trydrift/drift@v0` resolves, which only needs
the tag to exist.

### Bumping the version for a future release

Use `scripts/set-version.mjs` rather than hand-editing four files:

```bash
node scripts/set-version.mjs 0.1.1
npm run release:check
git add -A && git commit -m "release: 0.1.1"
git tag v0.1.1
git push origin v0.1.1
```

It updates `package.json`, `package-lock.json`, `extension/package.json`, and
`extension/package-lock.json` together and nothing else. It never creates a
git tag itself — bumping the version and tagging a release stay separate,
deliberate actions.
