/**
 * Turns the picks made on `/configure` into a `.github/drift.yml` and the
 * matching `.github/workflows/drift.yml` `with:` block.
 *
 * `drift.yml` only ever needs to state what differs from Drift's own
 * defaults — every field not present falls back to the conservative default
 * described in `docs/configuration.md` — so the generator only emits a key
 * once its value has actually moved off that default. A form that always
 * dumped every field would produce a config no shorter (and no more
 * readable) than pasting the whole schema.
 */

export type Mode = "approve" | "auto";
export type MaxAutoRisk = "none" | "low" | "medium" | "high";
export type AlertGranularity = "package" | "breakingChange" | "affectedSite";
export type IssueDefault = "issue" | "branch" | "both";
export type IssueGranularity = "package" | "change";

export interface ConfigureOptions {
  mode: Mode;
  maxAutoRisk: MaxAutoRisk;
  watchBranches: string[];
  codeScanningEnabled: boolean;
  granularity: AlertGranularity;
  includeInformational: boolean;
  createIssuesPerAlert: boolean;
  issueDefault: IssueDefault;
  issueGranularity: IssueGranularity;
  assignees: string[];
  prLabels: string[];
  prReviewers: string[];
  prDraft: boolean;
  outdatedEnabled: boolean;
  copilotToken: boolean;
  dryRun: boolean;
}

export const DEFAULT_OPTIONS: ConfigureOptions = {
  mode: "approve",
  maxAutoRisk: "medium",
  watchBranches: ["main", "master", "develop"],
  codeScanningEnabled: true,
  granularity: "package",
  includeInformational: false,
  createIssuesPerAlert: false,
  issueDefault: "issue",
  issueGranularity: "package",
  assignees: [],
  prLabels: [],
  prReviewers: [],
  prDraft: false,
  outdatedEnabled: false,
  copilotToken: true,
  dryRun: false,
};

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** A YAML flow sequence of quoted strings, e.g. `['a', 'b']`. Empty renders as `[]`. */
function stringList(values: readonly string[]): string {
  return `[${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ")}]`;
}

/**
 * The `.github/drift.yml` for these options — only the keys that differ from
 * `DEFAULT_OPTIONS`, each with a one-line comment, so the file stays a
 * legible diff against Drift's own defaults rather than a restatement of
 * the whole schema. An all-default selection returns just the header.
 */
export function generateDriftYaml(opts: ConfigureOptions): string {
  const lines: string[] = ["# .github/drift.yml — generated from Drift's /configure page", ""];
  const before = lines.length;

  if (opts.mode !== DEFAULT_OPTIONS.mode) {
    lines.push(
      opts.mode === "auto"
        ? "# Dispatch a fix as soon as a breaking change is detected, subject to maxAutoRisk and every guardrail below."
        : "# Analyse and file an approval issue for a human; never dispatch automatically.",
      `mode: ${opts.mode}`,
      "",
    );
  }

  if (opts.mode === "auto" && opts.maxAutoRisk !== DEFAULT_OPTIONS.maxAutoRisk) {
    lines.push(
      "# Highest risk level eligible for automatic dispatch; anything above falls back to approval.",
      `maxAutoRisk: ${opts.maxAutoRisk}`,
      "",
    );
  }

  if (!sameList(opts.watchBranches, DEFAULT_OPTIONS.watchBranches)) {
    lines.push("# Branches Drift acts on.", `watchBranches: ${stringList(opts.watchBranches)}`, "");
  }

  const codeScanningLines: string[] = [];
  if (opts.codeScanningEnabled !== DEFAULT_OPTIONS.codeScanningEnabled) {
    codeScanningLines.push(`  enabled: ${opts.codeScanningEnabled}`);
  }
  if (opts.granularity !== DEFAULT_OPTIONS.granularity) {
    codeScanningLines.push(`  granularity: ${opts.granularity}`);
  }
  if (opts.includeInformational !== DEFAULT_OPTIONS.includeInformational) {
    codeScanningLines.push(`  includeInformational: ${opts.includeInformational}`);
  }
  if (opts.createIssuesPerAlert !== DEFAULT_OPTIONS.createIssuesPerAlert) {
    codeScanningLines.push(`  createIssuesPerAlert: ${opts.createIssuesPerAlert}`);
  }
  if (codeScanningLines.length > 0) {
    lines.push(
      "# What's uploaded to the Security tab, and how alerts are grouped.",
      "codeScanning:",
      ...codeScanningLines,
      "",
    );
  }

  const issueCreationLines: string[] = [];
  if (opts.issueDefault !== DEFAULT_OPTIONS.issueDefault) {
    issueCreationLines.push(`  default: ${opts.issueDefault}`);
  }
  if (opts.issueGranularity !== DEFAULT_OPTIONS.issueGranularity) {
    issueCreationLines.push(`  granularity: ${opts.issueGranularity}`);
  }
  if (opts.assignees.length > 0) {
    issueCreationLines.push(`  assignees: ${stringList(opts.assignees)}`);
  }
  if (issueCreationLines.length > 0) {
    lines.push(
      "# The one-click \"file this\" action offered by the CLI and the VS Code extension.",
      "issueCreation:",
      ...issueCreationLines,
      "",
    );
  }

  const pullRequestLines: string[] = [];
  if (opts.prLabels.length > 0) pullRequestLines.push(`  labels: ${stringList(opts.prLabels)}`);
  if (opts.prReviewers.length > 0) pullRequestLines.push(`  reviewers: ${stringList(opts.prReviewers)}`);
  if (opts.prDraft !== DEFAULT_OPTIONS.prDraft) pullRequestLines.push(`  draft: ${opts.prDraft}`);
  if (pullRequestLines.length > 0) {
    lines.push("# Applied to every pull request Drift opens.", "pullRequest:", ...pullRequestLines, "");
  }

  if (opts.outdatedEnabled !== DEFAULT_OPTIONS.outdatedEnabled) {
    lines.push(
      "# Proactively scan every installed dependency's version, not just the ones a push just bumped.",
      "outdated:",
      `  enabled: ${opts.outdatedEnabled}`,
      "",
    );
  }

  if (lines.length === before) {
    lines.push("# Every option below is already Drift's default — nothing to override.", "");
  }

  return lines.join("\n").replace(/\n+$/, "\n");
}

/**
 * Patches the example workflow's `with:` block for the "Run Drift" step to
 * match these options, leaving every trigger, permission, and toolchain
 * step from the template untouched. The template comes from
 * `examples/workflows/*.yml` (see `action-templates.ts`) rather than being
 * rebuilt here, so the trigger-path list and every comment stay exactly
 * what ships in the repo.
 */
export function generateWorkflow(template: string, opts: ConfigureOptions, kind: "diff" | "outdated"): string {
  const withLines = ["        with:", "          repo-token: ${{ secrets.GITHUB_TOKEN }}"];
  if (kind === "diff" && opts.copilotToken) {
    withLines.push("          copilot-token: ${{ secrets.DRIFT_COPILOT_TOKEN }}");
  }
  if (kind === "outdated") {
    withLines.push("          scan-mode: outdated");
  }
  if (kind === "diff" && opts.mode !== DEFAULT_OPTIONS.mode) {
    withLines.push(`          mode: ${opts.mode}`);
  }
  if (kind === "diff" && opts.dryRun) {
    withLines.push("          dry-run: 'true'");
  }
  withLines.push("          alert-granularity: ${{ inputs.alert-granularity }}");

  const anchor =
    kind === "diff"
      ? [
          "        with:",
          "          repo-token: ${{ secrets.GITHUB_TOKEN }}",
          "          copilot-token: ${{ secrets.DRIFT_COPILOT_TOKEN }}",
          "          alert-granularity: ${{ inputs.alert-granularity }}",
        ].join("\n")
      : [
          "        with:",
          "          repo-token: ${{ secrets.GITHUB_TOKEN }}",
          "          scan-mode: outdated",
          "          alert-granularity: ${{ inputs.alert-granularity }}",
        ].join("\n");

  if (!template.includes(anchor)) {
    // The committed template moved out from under this generator — fail
    // visibly in the preview rather than silently shipping the unmodified
    // template with none of the form's choices applied.
    return `# Could not locate the "Run Drift" step in the template to customise.\n# Please copy examples/workflows/${kind === "diff" ? "drift.yml" : "drift-outdated.yml"} directly.\n\n${template}`;
  }

  return template.replace(anchor, withLines.join("\n"));
}
