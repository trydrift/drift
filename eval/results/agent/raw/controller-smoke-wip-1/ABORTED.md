# Exploratory plumbing check — never pool

`controller-smoke-wip-1` ran the three orchestration conditions on the synthetic smoke case from an **uncommitted** harness (`driftTreeDirty: true`) to find plumbing problems before the harness was committed.

It found one: the baseline session loaded two built-in tools (`ArtifactComments`, `ArtifactData`) that the orchestrated sessions did not, so the environment fingerprints differ (`b24568bfb9cc0f74` vs `8d69d817761f3509`). Every condition now disallows those two tools. The trials are kept for the audit trail and say nothing about the conditions.
