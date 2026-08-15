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
| `copilot-token` | — | **User-scoped**. Only needed for commits Drift can't resolve deterministically or via an enabled community recipe |
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

> **Not published to npm yet.** Until a release runs, clone the repo, run
> `npm install && npm run build`, and use `node dist/cli.js` in place of
> `drift` below.

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

Everything below is a repository or account setting. None of it lives in
source, and none of it can be created by a workflow — `release.yml` reads these
and fails loudly if one is missing, rather than pretending.

Before the first public tag:

| Prerequisite | Where | Why |
| --- | --- | --- |
| The repository is **public** | GitHub → Settings → General | `uses: trydrift/drift@v0` cannot resolve from a private repository, and the Marketplace listing links to it |
| **`NPM_TOKEN`** repository secret | npm automation token with publish rights on `@usedrift/cli` | Publishes the CLI. The package name is `@usedrift/cli`; the binary it installs is `drift` |
| **`VSCE_PAT`** repository secret | VS Code Marketplace personal access token for the `drift` publisher | Publishes the extension. `extension/package.json` must keep `"publisher": "drift"` and the `name`/`displayName`/`icon` it ships with — the Marketplace item id is `drift.drift` |
| **GitHub Pages enabled**, source **GitHub Actions** | GitHub → Settings → Pages | `pages.yml` deploys the site with `actions/deploy-pages`, which fails outright if the source is still set to a branch |

Then tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

`release.yml` validates every artifact before publishing any of them — the same
checks `npm run release:check` runs locally — then publishes the CLI to npm and
the extension to the Marketplace, creates the GitHub Release with the VSIX
attached, and moves the floating **`v0`** tag onto `v0.1.0` so
`uses: trydrift/drift@v0` resolves to it.

Run `npm run release:check` first. It is the same validation phase, step for
step, so a failure found locally is a failure that would have gone red in CI
after the tag was already public.
