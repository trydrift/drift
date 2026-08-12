import { cn } from "@/lib/cn";

/**
 * GitHub's own chrome, rebuilt small.
 *
 * The explanatory sections of this page used to be cards containing paragraphs
 * about diffs, release notes, annotations and commits. Every one of those is a
 * thing a developer looks at fifty times a day and recognises in a glance — so
 * showing the artefact says in one second what a paragraph about the artefact
 * says in thirty, and it also happens to be the honest way to describe a tool
 * whose entire output lands in a pull request.
 *
 * These are deliberately *evocations*, not clones. No GitHub asset, mark, or
 * stylesheet is used; the shapes are the familiar ones and every colour comes
 * from this page's own tokens, so the panels sit inside the design rather than
 * looking pasted in from another site.
 *
 * All of it is static markup — no client component, no JavaScript — because a
 * diff that cannot change does not need any.
 */

/* ── A framed panel with a file-header bar ─────────────────────────────── */

export function GhPanel({
  icon = "file",
  name,
  meta,
  children,
  className,
}: {
  icon?: PanelIcon;
  /** The filename, tag, or route the panel is showing. */
  name: React.ReactNode;
  /** Right-aligned detail: a line count, a status, a timestamp. */
  meta?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("overflow-hidden rounded-xl border border-border bg-surface", className)}>
      <div className="flex items-center gap-2 border-b border-border bg-surface-hover/50 px-3 py-2">
        <GhIcon icon={icon} className="size-3.5 shrink-0 text-faint" />
        <span className="truncate font-mono text-[11.5px] text-foreground">{name}</span>
        {meta && <span className="ml-auto shrink-0 font-mono text-[10.5px] text-faint">{meta}</span>}
      </div>
      {children}
    </div>
  );
}

/* ── Code, with a gutter ───────────────────────────────────────────────── */

export interface CodeLine {
  /** The line number shown in the gutter. Omit for a hunk header. */
  n?: number;
  text: string;
  /** `add` and `del` render as a diff; `hit` is the line a finding points at. */
  kind?: "add" | "del" | "hunk" | "hit" | "plain";
  /** A review-comment row rendered directly beneath this line. */
  note?: Note;
}

export interface Note {
  /** `found` is a reported site; `quiet` is a line Drift deliberately skips. */
  tone: "found" | "quiet";
  label: string;
  body: React.ReactNode;
}

export function Code({ lines }: { lines: readonly CodeLine[] }) {
  return (
    <div className="overflow-x-auto bg-(--pre-bg)">
      <table className="w-full border-collapse font-mono text-[11px] leading-[1.8]">
        <tbody>
          {lines.map((line, index) => (
            <CodeRow key={`${line.text}-${index}`} line={line} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CodeRow({ line }: { line: CodeLine }) {
  const kind = line.kind ?? "plain";
  const marker = kind === "add" ? "+" : kind === "del" ? "-" : " ";

  return (
    <>
      <tr
        className={cn(
          kind === "add" && "diff-add",
          kind === "del" && "diff-del",
          kind === "hit" && "bg-brand-soft",
          kind === "hunk" && "bg-surface-hover/60",
        )}
      >
        <td
          className="w-10 select-none border-r border-border/70 px-2 text-right align-top text-[10.5px] tabular"
          style={{ color: "hsl(var(--diff-gutter))" }}
        >
          {line.n ?? ""}
        </td>
        <td className="whitespace-pre px-3 align-top">
          <span
            className={cn(
              "select-none",
              kind === "add" ? "text-brand-text" : kind === "del" ? "text-rose-500" : "text-transparent",
            )}
          >
            {marker}
          </span>
          <span className={cn(kind === "hunk" ? "text-faint" : "text-foreground")}>{line.text}</span>
        </td>
      </tr>
      {line.note && (
        <tr>
          <td className="border-r border-border/70" />
          <td className="px-3 py-2">
            <NoteBox note={line.note} />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * The annotation row.
 *
 * Two tones, and the difference between them is the argument this page is
 * making: `found` is the review comment Drift leaves, `quiet` is the one it
 * refuses to leave and the reason why.
 */
function NoteBox({ note }: { note: Note }) {
  const quiet = note.tone === "quiet";

  return (
    <div
      className={cn(
        "max-w-2xl rounded-lg border px-3 py-2",
        quiet ? "border-dashed border-border bg-surface/70" : "border-brand/35 bg-brand-soft",
      )}
    >
      <p className="flex items-center gap-1.5 font-sans text-[11px] font-semibold">
        <span
          aria-hidden
          className={cn(
            "flex size-4 items-center justify-center rounded-full text-[9px]",
            quiet ? "bg-surface-hover text-faint" : "bg-brand text-brand-foreground",
          )}
        >
          {quiet ? "–" : "!"}
        </span>
        <span className={quiet ? "text-faint" : "text-brand-text"}>{note.label}</span>
      </p>
      <p className="mt-1 font-sans text-[12px] leading-relaxed text-muted">{note.body}</p>
    </div>
  );
}

/* ── Small pieces ──────────────────────────────────────────────────────── */

/** A GitHub-style label pill. */
export function GhBadge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "brand" | "warn";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] whitespace-nowrap",
        tone === "brand" && "border-brand/40 bg-brand-soft text-brand-text",
        tone === "warn" && "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        tone === "neutral" && "border-border bg-surface-hover text-faint",
      )}
    >
      {children}
    </span>
  );
}

/**
 * A commit row, as the commits tab draws one.
 *
 * Carries the resolution route where a commit page would carry a SHA, since
 * this page's commits are the shape of a Drift pull request rather than one
 * specific run — and a plausible-looking hash nobody can resolve is exactly
 * the sort of decoration the rest of the page refuses.
 */
export function GhCommit({
  tag,
  message,
  detail,
}: {
  tag: string;
  message: string;
  detail: string;
}) {
  return (
    <div className="flex items-start gap-3 px-3 py-2.5">
      <GhIcon icon="commit" className="mt-0.5 size-3.5 shrink-0 text-faint" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12.5px] font-medium text-foreground">{message}</p>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted">{detail}</p>
      </div>
      <span className="shrink-0 rounded-md bg-surface-hover px-1.5 py-0.5 font-mono text-[10.5px] text-faint">
        {tag}
      </span>
    </div>
  );
}

export type PanelIcon =
  | "file"
  | "tag"
  | "commit"
  | "check"
  | "issue"
  | "play"
  | "diff"
  | "search";

export function GhIcon({ icon, className }: { icon: PanelIcon; className?: string }) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden>
      {icon === "file" && (
        <>
          <path {...common} d="M9.5 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5z" />
          <path {...common} d="M9.5 1.5V5H13" />
        </>
      )}
      {icon === "tag" && (
        <>
          <path {...common} d="M1.5 7.5v-5a1 1 0 0 1 1-1h5l7 7-6 6z" />
          <circle {...common} cx="5" cy="5" r="1" />
        </>
      )}
      {icon === "commit" && (
        <>
          <circle {...common} cx="8" cy="8" r="2.5" />
          <path {...common} d="M1.5 8h4M10.5 8h4" />
        </>
      )}
      {icon === "check" && (
        <>
          <circle {...common} cx="8" cy="8" r="6.5" />
          <path {...common} d="m5 8 2 2 4-4" />
        </>
      )}
      {icon === "issue" && (
        <>
          <circle {...common} cx="8" cy="8" r="6.5" />
          <path {...common} d="M8 4.5v4M8 11h.01" />
        </>
      )}
      {icon === "play" && (
        <>
          <circle {...common} cx="8" cy="8" r="6.5" />
          <path {...common} d="m6.5 5.5 4 2.5-4 2.5z" />
        </>
      )}
      {icon === "diff" && (
        <>
          <path {...common} d="M4 1.5v5M1.5 4h5" />
          <path {...common} d="M9.5 12h5" />
          <path {...common} d="M2 9.5h4l8-6" />
        </>
      )}
      {icon === "search" && (
        <>
          <circle {...common} cx="7" cy="7" r="4.5" />
          <path {...common} d="m10.5 10.5 4 4" />
        </>
      )}
    </svg>
  );
}
