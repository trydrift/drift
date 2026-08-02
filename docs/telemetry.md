# Telemetry

Telemetry is off by default for local use. `DRIFT_TELEMETRY_DISABLED=1`,
`DRIFT_TELEMETRY_DISABLED=true`, or `DO_NOT_TRACK=1` disables it even when a
configuration file opts in.

Allowed opt-in fields are limited to dependency-upgrade outcome facts:
ecosystem, package, old/new version, taxonomy, evidence-source classes,
anonymized feature flags, confidence bands, gaps, check pass/fail/not-run
counts, agent type, execution result, user action, latency, and cost.

Drift must never collect source code, snippets, raw file paths, repository
names, organization names, secrets, prompts, model responses, or full command
output. Event construction is allow-listed and rejects prohibited field names or
private-key-shaped values before send.

Print the exact event shape before enabling collection:

```sh
drift telemetry print
```

Installation identifiers are hashed with a rotating salt. The default rotation
period is monthly, so event streams can support aggregate product learning
without creating a permanent install identifier.

The hosted service retention target is 180 days unless a customer agreement sets
a shorter period. Deletion requests should be handled by deleting all retained
events for the current and historical rotations of the provided installation
identifier hash.
