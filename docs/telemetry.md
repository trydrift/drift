# Telemetry — off by default

Telemetry is currently disabled unless you explicitly configure your own
collector endpoint. This repository does not include a hosted Drift telemetry
backend, database, or VS Code/Application Insights integration.

`DRIFT_TELEMETRY_DISABLED=1`, `DRIFT_TELEMETRY_DISABLED=true`, or
`DO_NOT_TRACK=1` disables telemetry even when a configuration file opts in.

Allowed opt-in fields are limited to dependency-upgrade outcome facts:
ecosystem, package, old/new version, taxonomy, evidence-source classes,
anonymized feature flags, confidence bands, gaps, check pass/fail/not-run
counts, agent type, execution result, user action, latency, and cost.

Drift must never collect source code, snippets, raw file paths, repository
names, organization names, secrets, prompts, model responses, or full command
output. Event construction is allow-listed and rejects prohibited field names or
private-key-shaped values before send.

Print the exact event shape before wiring a collector:

```sh
drift telemetry print
```

Installation identifiers are hashed with a rotating salt. The default rotation
period is monthly, so event streams can support aggregate product learning
without creating a permanent install identifier.

If a collector is added later, it should honour the event's `retentionDays`
field. The default requested retention window is 180 days.
