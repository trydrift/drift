"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import {
  DEFAULT_OPTIONS,
  generateDriftYaml,
  generateWorkflow,
  type ConfigureOptions,
} from "@/lib/generate-config";

/**
 * Pick the options, get the two files back. Every field starts at Drift's
 * own default (see `DEFAULT_OPTIONS`), so a visitor who changes nothing gets
 * exactly the zero-config install the rest of the site describes.
 */
export function ConfigureForm({
  workflowTemplate,
  outdatedTemplate,
}: {
  workflowTemplate: string;
  outdatedTemplate: string;
}) {
  const [opts, setOpts] = useState<ConfigureOptions>(DEFAULT_OPTIONS);

  const set = <K extends keyof ConfigureOptions>(key: K, value: ConfigureOptions[K]) =>
    setOpts((prev) => ({ ...prev, [key]: value }));

  const driftYaml = useMemo(() => generateDriftYaml(opts), [opts]);
  const workflowYaml = useMemo(() => generateWorkflow(workflowTemplate, opts, "diff"), [workflowTemplate, opts]);
  const outdatedYaml = useMemo(
    () => generateWorkflow(outdatedTemplate, opts, "outdated"),
    [outdatedTemplate, opts],
  );

  return (
    <div className="mt-7 grid gap-6 lg:grid-cols-[1fr_1.2fr] lg:items-start">
      <div className="grid gap-5">
        <Field label="Mode" hint="How autonomous Drift is allowed to be.">
          <Segmented
            value={opts.mode}
            onChange={(v) => set("mode", v)}
            options={[
              { value: "approve", label: "Approve" },
              { value: "auto", label: "Auto" },
            ]}
          />
        </Field>

        {opts.mode === "auto" && (
          <Field label="Max auto risk" hint="Anything riskier falls back to an approval request.">
            <Select
              value={opts.maxAutoRisk}
              onChange={(v) => set("maxAutoRisk", v as ConfigureOptions["maxAutoRisk"])}
              options={["none", "low", "medium", "high"]}
            />
          </Field>
        )}

        <Field label="Watch branches" hint="Comma-separated. Pushes elsewhere are ignored.">
          <TextList value={opts.watchBranches} onChange={(v) => set("watchBranches", v)} placeholder="main, master" />
        </Field>

        <Field label="Code scanning" hint="Upload findings to the Security tab.">
          <Toggle checked={opts.codeScanningEnabled} onChange={(v) => set("codeScanningEnabled", v)} label="Enabled" />
        </Field>

        {opts.codeScanningEnabled && (
          <>
            <Field label="Alert granularity" hint="How findings are grouped into alerts.">
              <Select
                value={opts.granularity}
                onChange={(v) => set("granularity", v as ConfigureOptions["granularity"])}
                options={["package", "breakingChange", "affectedSite"]}
              />
            </Field>
            <Field label="" hint="">
              <div className="flex flex-col gap-2">
                <Toggle
                  checked={opts.includeInformational}
                  onChange={(v) => set("includeInformational", v)}
                  label="Include informational findings (safe upgrades, resolved advisories)"
                />
                <Toggle
                  checked={opts.createIssuesPerAlert}
                  onChange={(v) => set("createIssuesPerAlert", v)}
                  label="Also file a GitHub issue per alert"
                />
              </div>
            </Field>
          </>
        )}

        <Field label="Issue creation" hint="The one-click action offered by the CLI and VS Code extension.">
          <div className="flex flex-col gap-3">
            <Select
              value={opts.issueDefault}
              onChange={(v) => set("issueDefault", v as ConfigureOptions["issueDefault"])}
              options={["issue", "branch", "both"]}
            />
            <Select
              value={opts.issueGranularity}
              onChange={(v) => set("issueGranularity", v as ConfigureOptions["issueGranularity"])}
              options={["package", "change"]}
            />
            <TextList
              value={opts.assignees}
              onChange={(v) => set("assignees", v)}
              placeholder="GitHub usernames to auto-assign"
            />
          </div>
        </Field>

        <Field label="Pull requests" hint="Applied to every pull request Drift opens.">
          <div className="flex flex-col gap-3">
            <TextList value={opts.prLabels} onChange={(v) => set("prLabels", v)} placeholder="Labels, comma-separated" />
            <TextList
              value={opts.prReviewers}
              onChange={(v) => set("prReviewers", v)}
              placeholder="Reviewers, comma-separated"
            />
            <Toggle checked={opts.prDraft} onChange={(v) => set("prDraft", v)} label="Open as draft" />
          </div>
        </Field>

        <Field label="Outdated-dependency scan" hint="Weekly scan of every installed version, not just what a push bumped.">
          <Toggle checked={opts.outdatedEnabled} onChange={(v) => set("outdatedEnabled", v)} label="Enabled" />
        </Field>

        <Field label="Workflow" hint="">
          <div className="flex flex-col gap-2">
            <Toggle
              checked={opts.copilotToken}
              onChange={(v) => set("copilotToken", v)}
              label="Include copilot-token (agent fallback for fixes Drift can't resolve itself)"
            />
            <Toggle checked={opts.dryRun} onChange={(v) => set("dryRun", v)} label="dry-run — report only, write nothing" />
          </div>
        </Field>
      </div>

      <div className="grid gap-4">
        <FileOutput filename=".github/drift.yml" content={driftYaml} />
        <FileOutput filename=".github/workflows/drift.yml" content={workflowYaml} />
        {opts.outdatedEnabled && <FileOutput filename=".github/workflows/drift-outdated.yml" content={outdatedYaml} />}
      </div>
    </div>
  );
}

/* ── Form controls ─────────────────────────────────────────────────────── */

function Field({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div>
      {label && <p className="text-[13px] font-medium text-foreground">{label}</p>}
      {hint && <p className="mt-0.5 text-[12px] leading-relaxed text-faint">{hint}</p>}
      <div className={cn(label ? "mt-2" : "")}>{children}</div>
    </div>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="inline-flex rounded-lg border border-border bg-surface p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            "rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors",
            value === opt.value ? "bg-brand text-brand-foreground" : "text-muted hover:text-foreground",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-[12.5px] text-foreground outline-none focus:border-brand"
    >
      {options.map((opt) => (
        <option key={opt} value={opt}>
          {opt}
        </option>
      ))}
    </select>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 text-[12.5px] text-muted">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-3.5 shrink-0 accent-[var(--brand)]"
      />
      <span>{label}</span>
    </label>
  );
}

function TextList({
  value,
  onChange,
  placeholder,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
}) {
  const [text, setText] = useState(value.join(", "));

  return (
    <input
      type="text"
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value);
        onChange(
          e.target.value
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        );
      }}
      className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-[12.5px] text-foreground outline-none placeholder:text-faint focus:border-brand"
    />
  );
}

/* ── Output panel ──────────────────────────────────────────────────────── */

function FileOutput({ filename, content }: { filename: string; content: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access denied — the text is still selectable in the panel.
    }
  };

  const downloadHref = `data:text/yaml;charset=utf-8,${encodeURIComponent(content)}`;
  const downloadName = filename.split("/").pop() ?? "drift.yml";

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border bg-surface-hover/50 px-3 py-2">
        <span className="truncate font-mono text-[11.5px] text-foreground">{filename}</span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={copy}
            className="rounded-md px-2 py-1 font-mono text-[10.5px] text-faint transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <a
            href={downloadHref}
            download={downloadName}
            className="rounded-md px-2 py-1 font-mono text-[10.5px] text-faint transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            Download
          </a>
        </div>
      </div>
      <pre className="max-h-96 overflow-auto bg-(--pre-bg) px-3 py-2.5 font-mono text-[11px] leading-[1.7] text-foreground">
        {content}
      </pre>
    </div>
  );
}
