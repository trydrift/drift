# Provenance note for runs v1-dev-1 and v1-dev-2

The trial artifacts and run manifests in these directories record the Drift commit they were produced at. Those commits were on a branch that was later rebased onto `main` before this work was opened as a pull request; the rebase changed hashes and nothing else (`git rebase --onto origin/main`, no conflicts). The content each recorded hash names is the content of its rebased counterpart below.

| Recorded (pre-rebase) | Rebased (in this branch) | Subject |
| --- | --- | --- |
| `fa06ee855901` | `800db25b883f` | feat(eval): paired coding-agent benchmark harness |
| `1c2c8d3342ae` | `a11cd4d33d68` | test(eval): cover the agent benchmark harness offline |
| `5a5e3a8ab752` | `27d8db764d1f` | feat(eval): smoke case and suite manifests for the agent benchmark |
| `724ab66e0a33` | `70f7fd86dbab` | feat(eval): constructed start states and a mined provenance for agent cases |
| `b74eb200d2de` | `c6fc1e52df41` | feat(eval): two real-repository cases for the agent benchmark |
| `22cc4a88d00b` | `158803b9630a` | feat(site): agent benchmark methodology page and gated proof block |
| `e35b2e5a272a` | `b7d66fcaf6d1` | docs: agent benchmark methodology, README block, and the paper's 79.9% |
| `b4aed4756b1b` | `c94876715d08` | ci: manual agent-benchmark workflow and the stale-claim check |
| `ead47284ce62` | `43f3834d2516` | feat(eval): historical ESLint 10 case with the maintainer's own fix |
| `eb15bcf456b8` | `5762e5a50c1b` | fix(eval): narrow two over-strict workaround rules, add offline rescore |
| `114e28b7152e` | `ffc51a60c22d` | fix(eval): quote rule descriptions that broke YAML parsing |
| `627bfda24d1e` | `4c986b7635af` | feat(eval): retry slots excluded for infrastructure failures |
| `56c497ae0fab` | `02cdb75b7f16` | chore(eval): first live agent-benchmark result (3 cases, 3 runs, not publishable) |

Trials recorded `driftCommit` values from this table's left column (`b4aed475…` for the first repetition, `ead47284…`/`627bfda2…` for later resumes and retries). Every run's `manifest.json` keeps the value of its last resume; each trial's `metadata.driftCommit` is its own.
