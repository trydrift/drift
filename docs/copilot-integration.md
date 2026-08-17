# Copilot integration, and the constraint that shapes Drift

This is the most important architectural document in the repository. One fact
about GitHub's Copilot API determines Drift's deployment model, its security
posture, and its answer to "do you need a database?"

## The constraint

> The Copilot coding agent API accepts **user-to-server tokens only**. Personal
> access tokens, OAuth app tokens, and GitHub App *user* tokens work.
> Server-to-server (GitHub App **installation**) tokens are rejected.

The reason is billing. Copilot is licensed per seat, so every agent task must be
attributable to a specific person's seat. An installation token identifies an app
acting on a repository — it names no user, so there is no seat to charge.

## What this rules out

The obvious architecture for "a GitHub App that watches your repos" is a hosted
multi-tenant backend: users install the App, the App receives webhooks, the App
acts. That architecture **cannot invoke Copilot**. Its installation tokens are
exactly the kind the agent API refuses.

To make it work, the backend would have to run an OAuth flow, obtain a user token
per installing user, and **store those tokens** — refreshing them, encrypting them
at rest, and rotating them on compromise.

That is a credential database. It is the single highest-consequence thing a
young company can be storing, and it would need to exist before the product had
proven it was worth anything.

## What Drift does instead

**The Action runs inside the customer's own trust boundary.**

```
┌── customer's GitHub repository ──────────────────────────────┐
│                                                              │
│  Secrets                                                     │
│   └── DRIFT_COPILOT_TOKEN  (user-scoped, never leaves here)   │
│                                                              │
│  Actions runner                                              │
│   └── Drift ── reads the secret from env                     │
│           └── POST api.github.com/agents/.../tasks           │
│                                                              │
└──────────────────────────────────────────────────────────────┘

        Drift the project receives: nothing.
```

The token is created by the user, stored by GitHub, injected by the Actions
runner, and sent to `api.github.com`. Drift's infrastructure is not in the path
at any point, because Drift has no infrastructure in this deployment.

This is why the Action deployment needs **no database and no authentication
system**. Not because we cut a corner — because we chose the deployment model
where the question doesn't arise.

(The self-hosted webhook runner does keep one local file: a queue of accepted
deliveries, so a restart cannot lose work GitHub has already been told was
accepted. It holds no credentials. See
[deployment](deployment.md#the-delivery-queue).)

It also happens to be the honest answer to the question every security reviewer
asks. "Where do you store my token?" — "We don't. It's in your repo secrets, and
we never see it."

## The trade-off, stated plainly

The hosted-App model is a better *product* experience: install once, covered
everywhere, nothing to configure per repository. Drift gives that up in
exchange for needing no credential store at all.

The webhook runner (`drift serve`) offers a middle path: the
multi-repo listening experience, self-hosted, single-tenant, with one token you
control. See [deployment.md](deployment.md).

---

## Setting up the token

### 1 · Create a fine-grained PAT

**Settings → Developer settings → Personal access tokens → Fine-grained tokens**

Scope it to the repositories Drift should work on, and grant:

| Permission | Access | Why |
| --- | --- | --- |
| Agent tasks | Read and write | The only permission the Agent Tasks API checks |
| Metadata | Read | Mandatory for fine-grained PATs |

That is the whole list, and it is deliberately short. This token does exactly
one thing: call GitHub's Agent Tasks endpoint. Everything else Drift does in a
workflow — reading source, creating the branch, filing the approval issue,
opening the pull request — runs on the separate `repo-token`, which defaults to
the workflow's built-in `GITHUB_TOKEN`.

Drift used to ask for `actions`, `contents`, `issues`, and `pull requests` here.
That list was wrong in the direction that hurts most: it was a set of
permissions the endpoint does not check, so following it granted broad repo
write access to a token that did not need it *and* still produced a 403,
because the one permission the endpoint does check was missing.

Installation tokens are not supported at all. If the token is a GitHub App
installation token, no permission set will make this work.

> **Public preview.** The Agent Tasks REST endpoint is in public preview, and
> which Copilot plans may call it is decided by GitHub, not by Drift — GitHub's
> own documentation has changed on this during the preview and is currently
> inconsistent between pages. Drift does not claim a list. Check
> [the endpoint documentation](https://docs.github.com/en/rest/agent-tasks/agent-tasks)
> for your plan before assuming a 403 is a Drift problem.

Set the shortest expiry you can operationally live with. Drift fails loudly on a
401 rather than silently degrading.

### 2 · Store it

**Repository → Settings → Secrets and variables → Actions → New repository secret**

Name it `DRIFT_COPILOT_TOKEN`.

### 3 · Prerequisites

- The account owning the token needs an active **Copilot** subscription with the
  coding agent enabled.
- The coding agent must be enabled for the repository (org policy can disable it).

---

## The API Drift calls

### Start a task

```http
POST /agents/repos/{owner}/{repo}/tasks
Authorization: Bearer <user-scoped token>
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28

{
  "prompt":  "<the full plan: findings, evidence, commit boundaries, rules>",
  "base_ref": "drift/acme-sdk-2-0-0-bbb2222",
  "create_pull_request": true
}
```

### Check status

```http
GET /agents/repos/{owner}/{repo}/tasks/{task_id}
```

States: `queued`, `in_progress`, `completed`, `failed`, `idle`,
`waiting_for_user`, `timed_out`, `cancelled`.

> The agent tasks API is in public preview and its shape may change.

---

## Why one task, not one per commit

Drift plans N separated commits but sends **one** task.

Each task is an independent agent session that creates its own branch and its own
pull request. N tasks would produce N pull requests that cannot see each other's
work — and commit 3 routinely depends on commit 1 having landed.

So the commit plan travels *inside* the prompt, with explicit instructions not to
squash or reorder. One session, sequenced commits, one reviewable PR.

## What Drift tells the agent not to do

An unsupervised coding agent has predictable failure modes. The prompt names each
one, because a rule the agent has read is worth more than a hope:

| Failure mode | The rule |
| --- | --- |
| Weakening tests until they pass | Update tests to the new API while asserting the same behaviour; leave a genuinely-broken test failing and explain why |
| Fixing unrelated things it noticed | Change only what the listed breaking changes require |
| Inventing a replacement API | Verify against the evidence and the installed package; if no replacement exists, say so |
| Guessing when unsure | Leave a `TODO(drift):` and flag it in the PR description — a flagged unknown is useful, a confident guess is not |
| Re-touching the dependency version | The upgrade is the input to the task, not part of it |
| Merging | Never |

---

## Failure handling

Every dispatch failure falls back to filing an approval issue. The analysis is
valuable to a human even when the agent could not be reached, so it is never
discarded.

| Status | What it means | Fix |
| --- | --- | --- |
| 401 | Token invalid or expired | Regenerate `DRIFT_COPILOT_TOKEN` |
| 403 | Wrong token type, no Copilot seat, or agent disabled | Confirm it's a **user** PAT, not an App token; check the subscription |
| 404 | Coding agent not enabled for the repo, or token lacks access | Enable it; check the token's repository scope |
| 422 | Request rejected as invalid | Usually a bad `base_ref`; check the branch exists |
| 429 | Rate limited | Retry later |

## Running without a Copilot token

Copilot is a fallback, not a requirement for analysis or deterministic
remediation.

Without `DRIFT_COPILOT_TOKEN`, Drift still detects the change, gathers
evidence, localizes affected code, builds the plan, and applies whatever it can
resolve deterministically — or via a validated fix plan — in
a pushed branch and pull request. Only a commit that still needs an agent after
that goes unresolved.

If one does, Drift reports that a Copilot token is required to finish it rather
than guessing or silently dropping the work — the Action files the approval
issue with the full report and commit plan; the CLI opens the pull request it
already has and marks it incomplete, then exits non-zero. `drift analyze` never
dispatches anything regardless of token, by construction.
