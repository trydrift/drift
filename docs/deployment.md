# Deployment

Three ways to run Drift. They share the same pipeline and differ only in what
surrounds it.

| | Infra | Localization | Multi-repo | Recommended for |
|---|---|---|---|---|
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
2. Create a fine-grained PAT (actions, contents, issues, pull requests — all
   read+write) and save it as the secret `DRIFT_COPILOT_TOKEN`.
3. Optionally copy [`examples/drift.yml`](../examples/drift.yml) to
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
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2   # Drift diffs against the previous commit
      - uses: drift-sh/drift@v0
        with:
          copilot-token: ${{ secrets.DRIFT_COPILOT_TOKEN }}
```

`fetch-depth: 2` matters. Without the previous commit there is no manifest diff,
and without a diff there is nothing to analyse.

### Inputs

| Input | Default | |
|---|---|---|
| `repo-token` | `${{ github.token }}` | Repository operations |
| `copilot-token` | — | **User-scoped**. Omit for analysis-only mode |
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

Drift analyses all manifests together. To scope it per package, run a matrix and
point `config-path` at per-package configs. Note the limitation in
[architecture.md](architecture.md#known-limitations): Drift doesn't model
workspace boundaries.

---

## 2 · CLI

```bash
npm install -g drift
export GITHUB_TOKEN=ghp_...
drift analyze
```

`analyze` is **read-only by construction** — no token is passed through to
dispatch and dry-run is forced. There is no code path in it that creates a
branch, an issue, or an agent task.

```
drift analyze --repo owner/name --before <sha> --after <sha> --dir ./path --json
```

Useful for:

- Evaluating Drift before granting any write permission
- Checking a dependency bump locally before pushing
- Piping `--json` into your own tooling

Other commands: `drift action` (Action entrypoint), `drift serve` (webhook
server).

---

## 3 · Webhook server (self-hosted)

The "App that watches your repos" experience, self-hosted and single-tenant.

```bash
export GITHUB_WEBHOOK_SECRET=...   # required — Drift refuses to run without it
export GITHUB_TOKEN=...
export DRIFT_COPILOT_TOKEN=...     # user-scoped
export PORT=3000

npm run build && npm run serve
```

Point a GitHub App or repository webhook at `POST /webhook` for **push** and
**issue_comment** events. `GET /health` is available for liveness checks.

### Two honest limitations

**No checkout, so no localization.** The server sees webhooks, not a working
tree. It detects changes and gathers evidence, but cannot search for affected
code without cloning. It warns at runtime rather than silently reporting zero
impact sites.

**Single-tenant.** The Copilot API needs a user-scoped token. Serving multiple
users would mean storing one token each — the credential database this MVP is
designed not to need.

Both are properties of the deployment model, not bugs. The Action has neither.

### Deploying it

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist ./dist
EXPOSE 3000
CMD ["node", "dist/runners/webhook.js"]
```

Runs anywhere that speaks HTTP — Fly, Railway, Cloud Run, a VM. It holds no
state, so scale horizontally freely and redeploy without migrations.

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
