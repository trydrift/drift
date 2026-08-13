import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The example workflow files, read straight from the repo rather than
 * duplicated here — `examples/workflows/*.yml` are the single source of
 * truth (`drift.yml` is itself generated from the manifest registry, see
 * `scripts/build-workflow.mjs`), and copying their content into the site
 * would just be a second place for them to go stale. This runs at build
 * time only: the site is a static export, so there is no request-time
 * Node process to read from.
 */

const repoRoot = join(process.cwd(), "..");

export const WORKFLOW_TEMPLATE = readFileSync(join(repoRoot, "examples/workflows/drift.yml"), "utf8");
export const OUTDATED_WORKFLOW_TEMPLATE = readFileSync(
  join(repoRoot, "examples/workflows/drift-outdated.yml"),
  "utf8",
);
