import type {
  Attachment,
  MessageAction,
  SessionBranchMode,
  SessionCommitMode,
  SessionMode,
  SessionPermission,
  TaskActivity,
  Task,
  TaskGroup,
  TaskState,
  ThreadItem,
} from '../session.js';
import { describeMode, describePermission, describePermissionShort } from '../labels.js';
import type { UpgradeCandidate } from '../upgrades.js';
import { describeSeverity, severityOf, type UpgradeSeverity } from '../severity.js';
import type { ReviewGroup, ReviewTotals } from '../review/store.js';
import type { BreakingChange, Evidence, RemediationPlan } from '../../../src/types.js';
import type { Vulnerability } from '../../../src/rationale/types.js';
import type { CheckOutcome } from '../../../src/verification/checks.js';
import { confidenceDisplay } from '../../../src/report/confidence.js';
import { highlightCode, languageForEcosystem } from './highlight.js';

/**
 * The panel's markup.
 *
 * Shape borrowed, deliberately, from Copilot Chat and Claude: one scrolling
 * transcript with a composer pinned underneath, and every control that changes
 * how the next turn behaves — agent, mode, effort, permissions, context — sitting
 * *in* that composer where the developer is already looking. Controls that live
 * far from the thing they affect are the reason a panel feels confusing, so the
 * only things in the view's title bar are the ones that act on the session as a
 * whole.
 *
 * Rendering is a pure function of the view model. The webview holds no state of
 * its own beyond the text being typed, which makes every update a full re-render
 * and removes a whole class of desynchronisation bug.
 */

export interface AgentChoice {
  id: string;
  label: string;
  available: boolean;
  detail?: string;
  reason?: string;
}

export interface SlashCommand {
  name: string;
  args?: string;
  /**
   * The command's name for people who have not learned to type it.
   *
   * The Tools menu is read by someone who does not yet know the vocabulary, so
   * it leads with this and keeps `/scan` as a quiet hint on the right — which is
   * also how the command is learned.
   */
  title: string;
  description: string;
}

/** One row in the composer menu. `id` comes straight back to the host. */
export interface MenuItem {
  id: string;
  label: string;
  detail?: string;
  /** Right-aligned, for the value a setting currently holds. */
  hint?: string;
  checked?: boolean;
  icon?: keyof typeof MENU_ICONS;
  /** Extra words the search box should match, never displayed. */
  keywords?: string;
  /**
   * Opens another section of this menu instead of acting.
   *
   * Used for the subscriptions: picking "Claude Code" is not a decision, it is
   * a request to see Claude's models. Drilling in happens inside the webview,
   * so it costs nothing and never leaves the menu.
   */
  submenu?: string;
}

export interface MenuSection {
  id: string;
  /** The control that opens this section. Several sections may share one. */
  anchor: string;
  title: string;
  items: MenuItem[];
  /** Rendered above the items, for a setting that is a range rather than a list. */
  slider?: MenuSlider;
}

/**
 * A setting with an order to it.
 *
 * Effort is not a set of unrelated options — it is one dial from "answer me now"
 * to "think as hard as you can", and a list of radio buttons hides that. The
 * stops come from the selected model, so a model with no reasoning budget never
 * shows a position that would do nothing.
 */
export interface MenuSlider {
  /** Prefix for the id sent back, e.g. `effort`. */
  id: string;
  /** Index into `stops`. */
  value: number;
  stops: { value: string; label: string; detail: string }[];
}

/**
 * Something changed since the scan on screen.
 *
 * A result list that silently describes a repository that no longer exists is
 * worse than no list at all, so the panel says so and offers the one action that
 * fixes it.
 */
export interface StaleHint {
  reason: 'dependencies' | 'code';
  label: string;
}

export interface ViewModel {
  nonce: string;
  repoLabel: string | null;
  signedInLabel: string | null;
  agents: AgentChoice[];
  agentId: string;
  agentLabel: string;
  mode: SessionMode;
  /**
   * What the active agent calls the effort it is set to — `Ultracode`, `Extra
   * High`, whatever its vendor says. `null` when the agent has no reasoning
   * budget at all, and the control is then left out rather than drawn dead.
   */
  effortLabel: string | null;
  /**
   * The model button's label: the chosen model's name, or the subscription's
   * when it is choosing for itself.
   *
   * `null` only when no agent is usable at all, where the button becomes the
   * invitation to set one up.
   */
  modelLabel: string | null;
  permission: SessionPermission;
  /** Where a fix works and whether Drift commits it. The git button's state. */
  branchMode: SessionBranchMode;
  commitMode: SessionCommitMode;
  /**
   * The scope button's label — `null` hides the button entirely, the same
   * rule the effort dial follows for an agent with no reasoning budget: a
   * control that can only ever offer one, unchanging choice is worse than no
   * control, because it is one more thing to read past for no reason.
   */
  scopeLabel: string | null;
  attachments: readonly Attachment[];
  thread: readonly ThreadItem[];
  /** Keyed by candidate id, for `packages` thread items. */
  candidates: Record<string, UpgradeCandidate>;
  review: { groups: readonly ReviewGroup[]; totals: ReviewTotals } | null;
  busy: boolean;
  /** Whether the running operation may be interrupted. Scans may not. */
  cancellable: boolean;
  /** The developer has asked the running operation to stop. */
  stopping: boolean;
  awaitingAnswer: boolean;
  commands: readonly SlashCommand[];
  /** Everything the composer menu offers, in the order it is shown. */
  menu: readonly MenuSection[];
  stale: StaleHint | null;
  /** Restored after a re-render so typing is never lost. */
  draft: string;
  /**
   * Bumped only when the host sets the draft itself.
   *
   * Between bumps the composer's contents belong to the developer, who may have
   * typed a character while a render was in flight. Without this the panel
   * occasionally swallowed the last keystroke of a fast typist.
   */
  draftToken: number;
  /** Namespaces the typewriter's per-message bookkeeping. */
  conversationId: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: '/scan',
    title: 'Scan dependencies',
    description: 'Check every dependency for a newer version and see what would break',
  },
  {
    name: '/recent',
    title: 'Check the last dependency change',
    description: 'Analyse the dependency change already in your git history',
  },
  {
    name: '/verify',
    title: 'Deep verify the last change',
    description: 'Install the change in a throwaway worktree and run this project’s own checks against it',
  },
  {
    name: '/upgrade',
    args: '<package>',
    title: 'Upgrade a package',
    description: 'Upgrade one package and check the impact',
  },
  {
    name: '/upgrade-all',
    title: 'Upgrade everything safe',
    description: 'Install every upgrade that does not affect your code',
  },
  {
    name: '/fix',
    args: '[package]',
    title: 'Fix affected code',
    description: 'Let your AI agent fix the affected code',
  },
  { name: '/review', title: 'Review changes', description: 'Show changes waiting to be kept or undone' },
  {
    name: '/redo',
    title: 'Try the fix again, differently',
    description: 'Say what is wrong and the agent starts over from the original files',
  },
  {
    name: '/discard',
    title: 'Throw away the agent’s edits',
    description: 'Restore every file the agent changed to how it was',
  },
  {
    name: '/commit',
    title: 'Commit the dependency changes',
    description: 'Branch and commit the manifests and lockfiles an upgrade changed',
  },
  { name: '/push', title: 'Push this branch', description: 'Send the current branch to origin' },
  {
    name: '/pr',
    title: 'Open a pull request',
    description: 'Push if needed, then raise a pull request carrying the evidence',
  },
  {
    name: '/issue',
    args: '[package]',
    title: 'Create a GitHub issue',
    description: 'Create an issue for a breaking change, prefilled with the evidence Drift found',
  },
  {
    name: '/instruction',
    args: '<text>',
    title: 'Add a workspace instruction',
    description: 'Tell every future agent run something about this repository',
  },
  { name: '/agent', title: 'Choose the AI agent', description: 'Choose which AI agent does the work' },
  { name: '/clear', title: 'New conversation', description: 'Start a new session' },
  { name: '/help', title: 'What Drift can do', description: 'Commands, agents, and how review works' },
];

/**
 * The whole document.
 *
 * Written once per webview. Every subsequent update posts `renderBody` instead,
 * because assigning `webview.html` tears down the document and re-runs the
 * script — which, on a panel holding a full scan, is the difference between a
 * click landing instantly and a click landing a second later.
 */
export function renderPanel(vm: ViewModel): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${vm.nonce}';">
<style>${STYLES}</style>
</head>
<body>
  <div id="root">${renderBody(vm)}</div>
  <script nonce="${vm.nonce}">${SCRIPT}</script>
</body>
</html>`;
}

/** Everything inside `#root`. Swapped in place on every update. */
export function renderBody(vm: ViewModel): string {
  return `${renderThread(vm)}\n${renderComposer(vm)}`;
}

/** The transcript region; safe to replace without touching the composer. */
export function renderThread(vm: ViewModel): string {
  return `<div class="thread" id="thread">${renderWelcomeRegion(vm)}${vm.thread.map((item) => renderThreadItem(item, vm)).join('')}</div>`;
}

/** The welcome area is independently invalidated when the first user turn arrives. */
export function renderWelcomeRegion(vm: ViewModel): string {
  const started = vm.thread.some((item) => item.kind === 'user');
  return `<div id="welcome-region">${started ? '' : renderWelcome(vm, vm.thread.length > 0)}</div>`;
}

/* ------------------------------------------------------------------ */
/* Welcome                                                             */
/* ------------------------------------------------------------------ */

function renderWelcome(vm: ViewModel, compact = false): string {
  return `<div class="welcome ${compact ? 'compact' : ''}">
    ${compact ? '' : `<div class="mark">${LOGO}</div>`}
    <h2>Which upgrades actually break your code?</h2>
    <p>Drift reads changelogs, release notes and API surfaces, proves which changes touch <em>your</em> files, then lets the AI agent you already have fix them. No API keys.</p>
    <div class="suggestions">
      <button data-action="run" data-command="/scan">
        <span class="icon">${ICON_SEARCH}</span>
        <span><b>Scan my dependencies</b><small>Every direct dependency, newest safe version, real impact</small></span>
      </button>
      <button data-action="run" data-command="/recent">
        <span class="icon">${ICON_HISTORY}</span>
        <span><b>Check my last dependency change</b><small>What the bump already in git actually broke</small></span>
      </button>
      <button data-action="run" data-command="/help">
        <span class="icon">${ICON_INFO}</span>
        <span><b>What can Drift do?</b><small>Commands, agents, and how review works</small></span>
      </button>
    </div>
    ${
      vm.agents.some((a) => a.available)
        ? `<p class="foot">Ready to use <b>${escapeHtml(vm.agentLabel)}</b>.</p>`
        : `<p class="foot warn">No AI agent found yet. Drift can still analyse and prove impact — <a data-action="openMenu" data-anchor="model:setup">choose an agent</a> when you want fixes.</p>`
    }
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Thread items                                                        */
/* ------------------------------------------------------------------ */

export function renderThreadItem(item: ThreadItem, vm: ViewModel): string {
  return `<div data-thread-id="${escapeAttr(item.id)}">${renderItem(item, vm)}</div>`;
}

function renderItem(item: ThreadItem, vm: ViewModel): string {
  switch (item.kind) {
    case 'user':
      return `<div class="turn user">
        <div class="who">
          ${ICON_USER}<span>You</span>
          ${
            // Rewind is offered on the turn that caused the change, because that
            // is where the developer looks when they want it undone: "put it
            // back to before I asked for this".
            item.checkpoint
              ? `<button class="ctl rewind" data-action="rewind" data-id="${escapeAttr(item.id)}" title="Restore every file to how it was before this message, and drop the conversation from here down">${ICON_REWIND}<span>Rewind</span></button>`
              : ''
          }
        </div>
        <div class="bubble">${renderMarkdown(item.text)}</div>
        ${
          item.attachments.length
            ? `<div class="chips small">${item.attachments.map((a) => `<span class="chip">${attachmentIcon(a)}${escapeHtml(a.label)}</span>`).join('')}</div>`
            : ''
        }
      </div>`;

    case 'assistant':
      // `data-type` is what the typewriter keys its progress on. It carries the
      // conversation id as well as the item id because item ids restart at `i1`
      // in every thread, and a reopened conversation must not retype what it
      // already typed.
      return `<div class="turn assistant">
        <div class="who">${LOGO_SMALL}<span>Drift</span></div>
        <div class="body markdown" data-type="${escapeAttr(`${vm.conversationId}:${item.id}`)}">${renderMarkdown(item.text)}</div>
        ${renderActions(item.actions)}
      </div>`;

    case 'notice':
      return `<div class="notice ${item.tone}">${noticeIcon(item.tone)}<div class="markdown">${renderMarkdown(item.text)}</div></div>`;

    case 'step':
      return renderStep(item);

    case 'packages':
      return renderPackages(item, vm);

    case 'tasks':
      return renderTasks(item);

    case 'question':
      return renderQuestion(item);

    case 'changes':
      return renderChanges(item.title, vm);
  }
}

/**
 * A running operation.
 *
 * The visible line is what Drift is doing *right now*, named specifically — the
 * package, the version, the file count. A generic "Scanning…" with a spinner is
 * indistinguishable from a hang, and a developer watching one has no way to tell
 * whether to wait or to give up.
 */
/**
 * What to do next, as buttons.
 *
 * The panel knew the next step and wrote it as prose — "say `/fix`", "say
 * `/commit`" — which is an instruction disguised as a sentence, and one that
 * only works for a reader who spots the difference. The commands still exist
 * for anyone who prefers typing; these run the same ones.
 */
function renderActions(actions: readonly MessageAction[] | undefined): string {
  if (!actions?.length) return '';
  return `<div class="msg-actions">${actions
    .map(
      (action) =>
        `<button class="${action.primary ? 'primary' : ''}" data-action="run" data-command="${escapeAttr(
          action.command,
        )}"${action.hint ? ` title="${escapeAttr(action.hint)}"` : ''}>${escapeHtml(action.label)}</button>`,
    )
    .join('')}</div>`;
}

function renderStep(item: Extract<ThreadItem, { kind: 'step' }>): string {
  const pct = item.total > 0 ? Math.round((item.done / item.total) * 100) : 0;
  const icon =
    item.state === 'running' ? '<span class="spinner"></span>' : item.state === 'done' ? ICON_CHECK : ICON_ERROR;

  return `<div class="step ${item.state}">
    <div class="step-head">
      ${icon}
      <b>${escapeHtml(item.title)}</b>
      ${item.total > 0 ? `<span class="count">${item.done} / ${item.total}</span>` : ''}
    </div>
    <div class="step-now">
      <span class="phase">${escapeHtml(item.phase)}</span>
      ${item.detail ? `<span class="detail">${linkifyPaths(item.detail)}</span>` : ''}
    </div>
    ${item.total > 0 ? `<div class="bar"><span style="width:${pct}%"></span></div>` : ''}
    ${renderStepOutput(item)}
    ${renderStepLog(item)}
  </div>`;
}

/**
 * Everything this step has done, in order — and the way into what each of
 * those printed.
 *
 * A phase that ran a command is a button: clicking it shows that command's
 * output in the terminal above. That replaces the row of tabs this used to
 * sit under, which tried to name a phase inside a badge a few characters wide
 * and ended up showing "Testing vitest@2…" over and over. The list already has
 * a full line for each phase; asking it the question directly is both more
 * precise and one control instead of two.
 *
 * Only phases that actually printed something are clickable. A phase with
 * nothing behind it that highlights on hover is an offer the panel cannot
 * keep.
 */
/**
 * A log line, split back into the phase it names and the detail after it.
 *
 * `session.ts` joins them with an em dash surrounded by spaces, so this is the
 * inverse of that one join and not a general parser: anything that does not
 * carry the separator is all phase, which is exactly how such a line was
 * written.
 */
function splitLogLine(text: string): [phase: string, detail: string] {
  const at = text.indexOf(' — ');
  return at === -1 ? [text, ''] : [text.slice(0, at), text.slice(at + 3)];
}

function renderStepLog(item: Extract<ThreadItem, { kind: 'step' }>): string {
  // Every line the step holds, not the last 60 of them. The summary right
  // above this counts the whole log, so truncating here promised "184 steps"
  // and delivered 60 — and the ones it dropped were the early ones, which is
  // where a scan says what it decided to look at. Anything that needs bounding
  // is bounded where the log is written, not where it is read, so the count
  // and the list cannot disagree again.
  if (item.log.length <= 1) return '';

  const withOutput = new Set(
    (item.outputs ?? []).filter((segment) => segment.lines.length > 0).map((segment) => segment.id),
  );

  const lines = item.log
    .map((entry) => {
      const clickable = entry.output && withOutput.has(entry.output);
      if (!clickable) return `<li>${linkifyPaths(entry.text)}</li>`;

      // The phase is the button; the detail stays outside it.
      //
      // A log line reads `phase — detail`, and the detail is where the file
      // paths are — which `linkifyPaths` turns into links that open them. Those
      // links cannot live inside the button: an anchor nested in a button is
      // invalid, and browsers disagree about which of the two a click or a
      // keypress belongs to, so the file link and the output picker would fight
      // over the same gesture. Splitting them gives each its own target and
      // keeps both working.
      const [phase, detail] = splitLogLine(entry.text);
      return `<li><button type="button" class="log-line" data-action="selectOutput" data-step="${escapeAttr(
        item.id,
      )}" data-seg="${escapeAttr(entry.output!)}" title="Show what this step printed">${escapeHtml(
        phase,
      )}</button>${detail ? `<span class="log-detail"> — ${linkifyPaths(detail)}</span>` : ''}</li>`;
    })
    .join('');

  return `<details class="log" data-key="log:${escapeAttr(item.id)}"><summary>${item.log.length} step${
    item.log.length === 1 ? '' : 's'
  }</summary><ol data-scroll="log:${escapeAttr(item.id)}">${lines}</ol></details>`;
}

/**
 * What the running command is printing.
 *
 * A typecheck or a test suite on a large repository is minutes long and,
 * without this, is indistinguishable from a hang — the reason "checking" felt
 * stuck was never that it was stuck, it was that the tool saying otherwise had
 * nowhere to say it.
 *
 * Every phase that printed anything keeps its own segment, and which one is
 * showing is a client-side choice (`selectOutput` in the page script, `mount()`
 * applies it) rather than anything the host tracks — the same reason a
 * disclosure's open/shut state lives in `ui.disclosures`. Left unset, the
 * default is "whichever segment is newest", so a step nobody has touched keeps
 * following the run.
 *
 * The one control here is that follow/pin toggle. Picking a *different* phase
 * is done by clicking that phase in the step list below, where it has a full
 * line to name itself in — see `renderStepLog`. This used to be a row of tabs
 * trying to fit "Testing vitest@2.1.9" into a badge, which produced a line of
 * near-identical ellipses and no way to tell them apart.
 */
function renderStepOutput(item: Extract<ThreadItem, { kind: 'step' }>): string {
  // A phase that printed nothing has nothing to show, and rendering an empty
  // terminal for it would make a step look like a command that produced no
  // output rather than one that never ran a command.
  const segments = (item.outputs ?? []).filter((segment) => segment.lines.length > 0);
  if (segments.length === 0) return '';

  const latestId = segments[segments.length - 1]!.id;

  return `<div class="step-output" data-key="stepout:${escapeAttr(item.id)}">
    ${
      // Nothing to follow or pin when there has only ever been one phase with
      // output: the toggle would be a control with one state.
      segments.length > 1
        ? `<div class="output-tabs">
            <span class="output-phase" data-phase-for="${escapeAttr(item.id)}">${escapeHtml(
              segments[segments.length - 1]!.phase,
            )}</span>
            <button type="button" class="output-tab live active" data-action="selectOutput" data-step="${escapeAttr(item.id)}" data-seg="live" title="Follow the phase Drift is running right now">Live</button>
          </div>`
        : ''
    }
    ${segments
      .map(
        (segment) =>
          `<pre class="${segment.id === latestId ? 'is-live' : ''}" data-step-output="${escapeAttr(item.id)}" data-seg="${escapeAttr(segment.id)}" data-phase="${escapeAttr(segment.phase)}" data-scroll="out:${escapeAttr(item.id)}:${escapeAttr(segment.id)}"><code>${escapeHtml(segment.lines.join('\n'))}</code></pre>`,
      )
      .join('')}
  </div>`;
}

/**
 * Turn the file paths inside a progress line into links that open the file.
 *
 * A step that says "Reading manifest — eval/fixtures/npm/consumer/package.json"
 * has already done the hard part of telling the developer where it is; making
 * them retype that path into a file picker to go and look is the whole distance
 * between a log and a tool. The same applies to the gitignored files a test
 * checkout reports carrying over or refusing to: those are named precisely so
 * someone can go and check them.
 *
 * Deliberately narrow about what counts. A token has to carry a path separator
 * or a known manifest name *and* an extension, so ordinary prose — a version
 * range, a package name, `3.4.5` — is never turned into a link that opens
 * nothing. Anything that does not match is escaped and passed through, so this
 * is safe to run over every line whether or not it names a file.
 */
export function linkifyPaths(text: string): string {
  // Repo-relative, no leading slash, at least one `/` or a bare filename with
  // an extension. Trailing punctuation is left out of the href so a path at the
  // end of a sentence still resolves.
  const pattern = /(?:[\w.@~-]+\/)*[\w.@~-]+\.[A-Za-z][\w]{0,9}\b/g;

  let out = '';
  let at = 0;

  for (const match of text.matchAll(pattern)) {
    const raw = match[0];
    const start = match.index;

    if (!looksLikePath(raw)) continue;

    out += escapeHtml(text.slice(at, start));
    out += `<a data-action="openFile" data-file="${escapeAttr(raw)}" data-line="1" title="Open ${escapeAttr(
      raw,
    )}"><code>${escapeHtml(raw)}</code></a>`;
    at = start + raw.length;
  }

  return out + escapeHtml(text.slice(at));
}

/**
 * Is this token a path worth offering to open, rather than a version or a
 * dotted identifier that happens to have the same shape?
 *
 * `react@19.2.0` and `1.2.3` both match a path-ish pattern and neither is a
 * file. A link that opens nothing is worse than plain text, because it invites
 * a click and then does nothing with it.
 */
function looksLikePath(token: string): boolean {
  // A version, whole or partial — the single most common false match.
  if (/^v?\d+(\.\d+)*$/.test(token)) return false;
  // `name@1.2.3`, which the scan prints constantly.
  if (/@\d/.test(token)) return false;

  const extension = token.slice(token.lastIndexOf('.') + 1);
  // An all-digit "extension" is a version tail, not a file type.
  if (/^\d+$/.test(extension)) return false;

  return token.includes('/') || KNOWN_FILENAMES.has(token);
}

/**
 * Files worth linking even with no directory in front of them, because a scan
 * names them at the repository root constantly and they are exactly what the
 * reader wants to open.
 */
const KNOWN_FILENAMES = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'deno.json',
  'Cargo.toml',
  'Cargo.lock',
  'go.mod',
  'go.sum',
  'pyproject.toml',
  'requirements.txt',
  'Pipfile',
  'poetry.lock',
  'uv.lock',
  'Gemfile',
  'Gemfile.lock',
  'composer.json',
  'composer.lock',
  'pubspec.yaml',
  'pubspec.lock',
  'mix.exs',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'build.sbt',
  'Package.swift',
  'Podfile',
  'Podfile.lock',
  'conanfile.txt',
  'vcpkg.json',
  '.gitignore',
]);

/* ------------------------------------------------------------------ */
/* The plan, as a checklist                                            */
/* ------------------------------------------------------------------ */

/**
 * What the agent is going to do, before it does it.
 *
 * The alternative — and what this replaced — is a wall of streamed agent
 * chatter, which asks the developer to read a transcript to answer three
 * questions they will ask continuously: what is the plan, where is it now, and
 * what has it already changed. A checklist answers all three without reading:
 * every commit unit is a row, every breaking change under it names the file and
 * line it lands on, and the state of each is a box that is empty, spinning, or
 * ticked.
 *
 * The whole list exists before the first edit, so the shape of the work is
 * visible while there is still time to stop it.
 */
function renderTasks(item: Extract<ThreadItem, { kind: 'tasks' }>): string {
  const settled = item.groups.filter((group) => group.state !== 'pending' && group.state !== 'active').length;
  const active = item.groups.some((group) => group.state === 'active');

  return `<div class="turn assistant">
    <div class="who">${LOGO_SMALL}<span>Drift</span></div>
    <div class="card tasks">
      <div class="card-head">
        <span class="card-title">${ICON_CHECKLIST}<b>${escapeHtml(item.title)}</b></span>
        <span class="tallies"><span class="tally"><b>${settled}</b> of ${item.groups.length} done</span></span>
      </div>
      ${item.subtitle ? `<p class="tasks-sub">${escapeHtml(item.subtitle)}</p>` : ''}
      ${item.groups.map((group, index) => renderTaskGroup(group, index + 1, active)).join('')}
    </div>
  </div>`;
}

function renderTaskGroup(group: TaskGroup, order: number, listActive: boolean): string {
  // The group in progress opens itself; the rest stay shut so a twelve-commit
  // plan is still one screen. Once nothing is running, everything that produced
  // a result is worth reading, so it all opens.
  const open = group.state === 'active' || (!listActive && group.state !== 'pending');

  return `<details class="task-group ${group.state}" data-key="task:${escapeAttr(group.id)}" ${open ? 'open' : ''}>
    <summary>
      ${taskBox(group.state)}
      <span class="task-order">${order}</span>
      <span class="task-title">
        <b>${escapeHtml(group.title)}</b>
        ${group.note ? `<small class="task-note">${escapeHtml(group.note)}</small>` : ''}
      </span>
      ${group.package ? `<span class="task-pkg">${escapeHtml(group.package)}</span>` : ''}
      <span class="task-state ${group.state}">${escapeHtml(stateLabel(group.state, group.tasks.length))}</span>
    </summary>
    <ul class="task-list">
      ${group.tasks.map(renderTask).join('')}
    </ul>
    ${renderGroupReason(group)}
    ${renderActivity(group)}
  </details>`;
}

/**
 * Why a commit unit ended the way it did, where the reader is already looking.
 *
 * "No change needed" is a verdict on a breakage Drift itself reported, and
 * shown alone it is unreadable in both directions: the developer cannot tell
 * whether the agent checked carefully and was right, or ran out of ideas. The
 * answer was in the agent's final message the whole time. It goes directly
 * under the tasks it explains, above the drawer, because a reason nobody
 * expands is a reason nobody reads.
 */
function renderGroupReason(group: TaskGroup): string {
  if (!group.reason || group.state === 'active' || group.state === 'pending') return '';
  return `<div class="task-reason ${group.state}">${renderMarkdown(group.reason)}</div>`;
}

function renderActivity(group: TaskGroup): string {
  const activity = group.activity ?? [];
  if (activity.length === 0) return '';

  const open = group.state === 'active';
  return `<details class="activity" data-key="activity:${escapeAttr(group.id)}" ${open ? 'open' : ''}>
    <summary>
      <span>Model work</span>
      <small>${activity.length} event${activity.length === 1 ? '' : 's'}</small>
    </summary>
    <div class="activity-list" data-scroll="activity:${escapeAttr(group.id)}">
      ${activity.slice(-40).map(renderActivityItem).join('')}
    </div>
  </details>`;
}

function renderActivityItem(item: TaskActivity): string {
  const file = item.file
    ? `<a data-action="openFile" data-file="${escapeAttr(item.file)}" data-line="1"><code>${escapeHtml(item.file)}</code></a>`
    : '';
  const stat =
    item.kind === 'edit' && (item.added || item.removed)
      ? `<span class="activity-stat"><span class="add">+${item.added ?? 0}</span> <span class="del">-${item.removed ?? 0}</span></span>`
      : '';

  // The kind and the title agree far more often now that both are precise, and
  // printing "Read Read" on every row would spend the drawer's narrowest column
  // saying one thing twice.
  const label = activityLabel(item.kind);
  const subtitle = item.title === label ? '' : `<span>${escapeHtml(item.title)}</span>`;

  return `<div class="activity-item ${item.kind}">
    <div class="activity-dot"></div>
    <div class="activity-body">
      <div class="activity-head">
        <b>${escapeHtml(label)}</b>
        ${subtitle}
        ${file}
        ${stat}
      </div>
      ${item.detail ? renderActivityDetail(item.detail) : ''}
      ${renderActivityLinks(item.links)}
      ${item.input ? renderIo('IN', item.input) : ''}
      ${item.output ? renderIo('OUT', item.output) : ''}
      ${item.lines?.length ? renderDiffPreview(item.lines) : ''}
    </div>
  </div>`;
}

/**
 * A line of raw agent chatter is prose more often than not, but the
 * unclassified fallback (`agent-activity.ts`'s `Thinking` bucket) also
 * catches genuine source lines — a `rg`/`cat` result, a bundle's minified
 * contents — that a CLI printed without announcing what it was. Rendered
 * through `linkify` alone, those collapse into a squished proportional-font
 * paragraph with no monospace alignment, which is what "code isn't
 * formatted" was describing. A quick, conservative check for code-shaped
 * punctuation routes those lines through the same monospace block real
 * command output already gets, instead of every detail line paying for it.
 */
function renderActivityDetail(detail: string): string {
  if (looksLikeCode(detail)) {
    // `activity-code`, not `activity-io`: the latter is a two-column grid whose
    // first track is the 34px `IN`/`OUT` gutter. Reusing it for a block with no
    // label put the code itself in that 34px column, which is why every such
    // snippet wrapped at about three characters and was unreadable.
    return `<pre class="activity-code"><code>${escapeHtml(detail)}</code></pre>`;
  }
  return `<div class="activity-detail">${linkify(detail)}</div>`;
}

function looksLikeCode(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  // A grep/cat-style `123:` or `123\t` line-number prefix.
  if (/^\d+[:\t]/.test(trimmed)) return true;
  // Declarations and punctuation-dense lines prose doesn't produce.
  if (/^(import|export|const|let|var|function|class|def|return|if|for|while)\b/.test(trimmed)) return true;
  if (/[{}();]/.test(trimmed) && /[=:]/.test(trimmed)) return true;
  return false;
}

/**
 * The pages the agent said it was reading, as things you can actually open.
 *
 * A migration fix is only as good as the source it was based on, and the one
 * question a reviewer has about "consulted the changelog" is *which* changelog.
 * Listing them separately from the prose means they stay clickable even when
 * the surrounding line is truncated.
 */
function renderActivityLinks(links: readonly string[] | undefined): string {
  if (!links?.length) return '';
  return `<div class="activity-links">${links
    .map(
      (url) =>
        `<a class="activity-link" data-action="openUrl" data-url="${escapeAttr(url)}" title="${escapeAttr(url)}">${ICON_LINK}<span>${escapeHtml(
          linkLabel(url),
        )}</span></a>`,
    )
    .join('')}</div>`;
}

/** Host and enough path to tell two pages on one site apart. */
function linkLabel(url: string): string {
  const match = /^https?:\/\/([^/]+)(\/[^?#]*)?/.exec(url);
  if (!match) return url;
  const host = match[1]!.replace(/^www\./, '');
  const path = (match[2] ?? '').replace(/\/$/, '');
  const label = `${host}${path}`;
  return label.length > 64 ? `${label.slice(0, 61)}…` : label;
}

/**
 * Turn bare URLs in a line of agent chatter into links.
 *
 * Matches against the raw text and escapes each piece on the way out. Escaping
 * first would be the obvious order and is wrong: `&` becomes `&amp;` before the
 * URL pattern ever runs, so every query string would be captured in its
 * entity-encoded form and then encoded a second time on the way into the
 * attribute — a link that looks right and opens the wrong page.
 */
export function linkify(text: string): string {
  const pattern = /https?:\/\/[^\s<>"'`)\]}]+/g;
  let out = '';
  let at = 0;

  for (const match of text.matchAll(pattern)) {
    const raw = match[0];
    const start = match.index;
    const trailing = /[.,;:!?]+$/.exec(raw)?.[0] ?? '';
    const url = raw.slice(0, raw.length - trailing.length);

    out += escapeHtml(text.slice(at, start));
    out += `<a data-action="openUrl" data-url="${escapeAttr(url)}">${escapeHtml(url)}</a>${escapeHtml(trailing)}`;
    at = start + raw.length;
  }

  return out + escapeHtml(text.slice(at));
}

function renderIo(label: string, text: string): string {
  return `<pre class="activity-io"><span>${escapeHtml(label)}</span><code>${escapeHtml(text)}</code></pre>`;
}

function renderDiffPreview(lines: Readonly<NonNullable<TaskActivity['lines']>>): string {
  return `<pre class="activity-diff">${lines
    .map((line) => `<span class="${line.kind}">${escapeHtml(diffPrefix(line.kind))}${escapeHtml(line.text)}</span>`)
    .join('')}</pre>`;
}

function activityLabel(kind: TaskActivity['kind']): string {
  switch (kind) {
    case 'bash':
      return 'Bash';
    case 'edit':
      return 'Edit';
    case 'create':
      return 'Create';
    case 'read':
      return 'Read';
    case 'search':
      return 'Search';
    case 'status':
      return 'Step';
    default:
      return 'Thinking';
  }
}

function diffPrefix(kind: 'add' | 'del' | 'context'): string {
  if (kind === 'add') return '+ ';
  if (kind === 'del') return '- ';
  return '  ';
}

function renderTask(task: Task): string {
  const where =
    task.file !== undefined
      ? `<a data-action="openFile" data-file="${escapeAttr(task.file)}" data-line="${task.line ?? 1}"><code>${escapeHtml(task.file)}${task.line ? `:${task.line}` : ''}</code></a>`
      : '';

  return `<li class="task ${task.state}">
    ${taskBox(task.state)}
    <span class="task-body">
      <span class="task-label">${escapeHtml(task.label)}</span>
      ${where}
      ${task.detail ? `<span class="task-detail">${escapeHtml(task.detail)}</span>` : ''}
    </span>
  </li>`;
}

/** The box itself: empty, spinning, ticked, or crossed. */
function taskBox(state: TaskState): string {
  if (state === 'active') return '<span class="spinner"></span>';
  if (state === 'done') return `<span class="box done">${ICON_CHECK}</span>`;
  if (state === 'failed') return `<span class="box failed">${ICON_CLOSE}</span>`;
  if (state === 'skipped' || state === 'unchanged') return `<span class="box skipped">${ICON_DASH}</span>`;
  return '<span class="box"></span>';
}

function stateLabel(state: TaskState, count: number): string {
  switch (state) {
    case 'active':
      return 'Working';
    case 'done':
      return 'Changed';
    case 'unchanged':
      return 'No change needed';
    case 'skipped':
      return 'Skipped';
    case 'failed':
      return 'Failed';
    default:
      return `${count} site${count === 1 ? '' : 's'}`;
  }
}

function renderQuestion(item: Extract<ThreadItem, { kind: 'question' }>): string {
  const answered = item.answer !== undefined;
  return `<div class="turn assistant question ${answered ? 'answered' : 'open'}">
    <div class="who">${LOGO_SMALL}<span>Drift asks</span></div>
    <div class="body markdown">${renderMarkdown(item.text)}</div>
    ${
      answered
        ? `<div class="answered-with">${ICON_CHECK}<span>${escapeHtml(item.answer!)}</span></div>`
        : `<div class="options">
            ${item.options
              .map(
                (option) =>
                  `<button data-action="answer" data-id="${escapeAttr(item.id)}" data-value="${escapeAttr(option.value)}">
                    <b>${escapeHtml(option.label)}</b>
                    ${option.description ? `<small>${escapeHtml(option.description)}</small>` : ''}
                  </button>`,
              )
              .join('')}
          </div>
          ${item.allowFreeText ? '<p class="hint">Or type your own answer below.</p>' : ''}`
    }
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Packages                                                            */
/* ------------------------------------------------------------------ */

/**
 * The scan result.
 *
 * One card, not a scatter of boxes. Everything a scan produced — the count that
 * decides what to do next, the packages that need attention, and the far longer
 * list that does not — lives inside a single bordered surface with hairline
 * separators, so it reads as one answer to one question rather than as three
 * widgets that happen to be stacked. Rows carry no borders of their own; the
 * card supplies the frame.
 */
function renderPackages(item: Extract<ThreadItem, { kind: 'packages' }>, vm: ViewModel): string {
  const candidates = item.ids.map((id) => vm.candidates[id]).filter((c): c is UpgradeCandidate => Boolean(c));
  if (candidates.length === 0) {
    return `<div class="turn assistant"><div class="who">${LOGO_SMALL}<span>Drift</span></div><div class="body markdown">${renderMarkdown(item.headline)}</div></div>`;
  }

  // Anything still in flight has not reached a verdict yet — for a re-check,
  // `severityOf` used to fall through to `clean` and count a package still
  // being examined as though it had already been found safe. Pulled out first
  // so none of the buckets below ever see one.
  const checking = candidates.filter(
    (c) => c.status === 'pending' || c.status === 'checking' || c.status === 'upgrading',
  );
  const settled = candidates.filter((c) => !checking.includes(c));

  const affected = settled.filter((c) => severityOf(c) === 'affected');
  // A failed verification has no located call site, but it is measured
  // evidence the upgrade broke the project's own checks — closer to
  // `affected` than to anything that could be called "safe", so it gets its
  // own group rather than silently vanishing from every bucket below.
  const verificationFailed = settled.filter((c) => severityOf(c) === 'verification-failed');
  const unchecked = settled.filter((c) => severityOf(c) === 'unchecked');
  const safe = settled.filter(
    (c) => severityOf(c) === 'clean' || severityOf(c) === 'upstream-only',
  );
  const failed = settled.filter((c) => severityOf(c) === 'error');
  // More than one repository actually contributed to this list — not just
  // more than one open, since a scope-narrowed scan should read the same as
  // a single-repository one.
  const showRepo = new Set(candidates.map((c) => c.repoRoot).filter(Boolean)).size > 1;

  return `<div class="turn assistant">
    <div class="who">${LOGO_SMALL}<span>Drift</span></div>
    <div class="body markdown">${renderMarkdown(item.headline)}</div>

    <div class="card packages">
      <div class="card-head">
        <span class="card-title">${ICON_PACKAGE}<b>Packages</b></span>
        <span class="tallies">
          ${affected.length ? tally(affected.length, 'affected', 'affected') : ''}
          ${verificationFailed.length ? tally(verificationFailed.length, 'checks failed', 'error') : ''}
          ${unchecked.length ? tally(unchecked.length, 'unverified', 'unchecked') : ''}
          ${safe.length ? tally(safe.length, 'safe', 'clean') : ''}
          ${failed.length ? tally(failed.length, 'unknown', 'error') : ''}
          ${checking.length ? tally(checking.length, 'in progress', 'unchecked') : ''}
        </span>
        ${
          // Only offered once there is something Deep Verification hasn't
          // already settled — a scan with everything already `verified` or
          // `error` would offer an action with nothing eligible for it to do.
          candidates.some((c) => !c.verification && c.status !== 'pending' && c.status !== 'checking' && c.status !== 'upgrading')
            ? `<button class="ctl bordered" data-action="verifyAll" title="Deep Verify: install and run this project's own checks against every unmeasured candidate">Deep Verify All</button>`
            : ''
        }
        <button class="ctl icon" data-action="rescan" title="Check every dependency again" aria-label="Rescan">${ICON_REFRESH}</button>
      </div>

      ${vm.stale ? renderStale(vm.stale) : ''}

      ${
        affected.length
          ? `<section class="pkg-group">
              <h4 class="pkg-subhead affected">${ICON_ALERT}<span>Affects your code</span><small>${affected.length}</small></h4>
              <div class="pkg-list">${affected.map((c) => renderCandidate(c, affected.length === 1, showRepo)).join('')}</div>
              ${
                affected.length > 1
                  ? `<div class="pkg-group-foot"><button class="primary wide" data-action="fixAll">Upgrade and fix all ${affected.length} with ${escapeHtml(vm.agentLabel)}</button><button class="wide" data-action="fileIssueAll" title="Create one GitHub issue per affected dependency, so the work is tracked even if nobody fixes it today">Create ${affected.length} issues</button></div>`
                  : ''
              }
            </section>`
          : ''
      }

      ${
        verificationFailed.length
          ? `<section class="pkg-group">
              <h4 class="pkg-subhead error">${ICON_ALERT}<span>Verified breaking</span><small>${verificationFailed.length}</small></h4>
              <div class="pkg-list">${verificationFailed.map((c) => renderCandidate(c, verificationFailed.length === 1, showRepo)).join('')}</div>
            </section>`
          : ''
      }

      ${
        // Open by default, and above the safe list. An upgrade nothing could be
        // read about is the one a developer most needs to see before they reach
        // for a bulk action — collapsing it would reproduce the failure this
        // group exists to prevent.
        unchecked.length
          ? `<section class="pkg-group">
              <h4 class="pkg-subhead unchecked">${ICON_ALERT}<span>Could not verify</span><small>${unchecked.length}</small></h4>
              <div class="pkg-list">${unchecked.map((c) => renderCandidate(c, unchecked.length === 1, showRepo)).join('')}</div>
            </section>`
          : ''
      }

      ${
        // Above the safe list, same as `unchecked` — a package still being
        // re-checked has no verdict at all yet, which is a weaker claim than
        // "safe" and deserves its own place rather than sitting among upgrades
        // that were actually cleared.
        checking.length
          ? `<section class="pkg-group">
              <h4 class="pkg-subhead unchecked"><span class="spinner"></span><span>Checking your packages</span><small>${checking.length}</small></h4>
              <div class="pkg-list">${checking.map((c) => renderCandidate(c, checking.length === 1, showRepo)).join('')}</div>
            </section>`
          : ''
      }

      ${
        safe.length
          ? `<details class="pkg-group" data-key="grp:safe">
              <summary><h4 class="pkg-subhead clean">${ICON_CHEVRON_RIGHT}${ICON_CHECK}<span>Safe to upgrade</span><small>${safe.length}</small></h4></summary>
              <div class="pkg-list">${safe.map((c) => renderCandidate(c, false, showRepo)).join('')}</div>
              ${
                // The counterpart to "Fix all". These are the upgrades with
                // nothing to decide — no code here touches what changed — so the
                // whole group is one action, taken within the ranges already in
                // package.json.
                safe.length > 1
                  ? `<div class="pkg-group-foot"><button class="wide" data-action="upgradeAll" title="Install every one of these, each within the range already in package.json">Upgrade all ${safe.length}</button><button class="wide" data-action="fileIssueSafe" title="File one GitHub issue per package, so each upgrade is tracked even before anyone takes it">Create ${safe.length} issues</button></div>`
                  : ''
              }
            </details>`
          : ''
      }

      ${
        failed.length
          ? `<details class="pkg-group" data-key="grp:failed">
              <summary><h4 class="pkg-subhead error">${ICON_CHEVRON_RIGHT}${ICON_ERROR}<span>Could not check</span><small>${failed.length}</small></h4></summary>
              <div class="pkg-list">${failed.map((c) => renderCandidate(c, false, showRepo)).join('')}</div>
            </details>`
          : ''
      }
    </div>
  </div>`;
}

function tally(count: number, label: string, tone: string): string {
  return `<span class="tally ${tone}"><b>${count}</b> ${escapeHtml(label)}</span>`;
}

function renderStale(stale: StaleHint): string {
  return `<div class="stale">
    ${ICON_INFO}
    <span>${escapeHtml(stale.label)}</span>
    <button data-action="rescan">Rescan</button>
  </div>`;
}

/**
 * Which ecosystem, which repository, and which package in it this dependency
 * belongs to.
 *
 * The ecosystem is always shown: one scan routinely covers several at once,
 * and `zod` on npm and a `zod` module on another registry are two different
 * packages that a name alone does not tell apart. The other two halves are
 * rendered only when the scan actually crossed that boundary — a repository
 * tag only once results came from more than one open root, a workspace tag
 * only once a scan crossed a package boundary within one repository.
 */
function workspaceTag(candidate: UpgradeCandidate, showRepo: boolean): string {
  const ecosystem = `<span class="pkg-ecosystem" title="${escapeAttr(candidate.ecosystem)} package, installed with ${escapeAttr(candidate.packageManager)}">${escapeHtml(candidate.ecosystem)}</span>`;
  const repo = showRepo ? (candidate.repoLabel ?? null) : null;
  // `workspace` is `''` for the root package, which is a real answer and not a
  // missing one — so it is tested against `undefined`, not for truthiness. The
  // old check treated the root as unlabelled, which is what made one of the two
  // `zod` rows in a root-plus-`extension/` checkout carry no tag: the scan knew
  // perfectly well where it came from and the row declined to say.
  const member =
    candidate.workspace === undefined
      ? null
      : (candidate.workspaceName ?? (candidate.workspace === '' ? 'repository root' : candidate.workspace));
  if (!repo && !member) return `<span class="pkg-tags">${ecosystem}</span>`;

  const repoTag = repo
    ? `<span class="pkg-workspace pkg-repo" title="Open root">${escapeHtml(repo)}</span>`
    : '';
  const memberTag = member
    ? `<span class="pkg-workspace" title="Declared in ${escapeAttr(candidate.manifestPath)}">${escapeHtml(member)}</span>`
    : '';
  // One row of tags rather than a stack: `.pkg-name` is a column, so three
  // free-standing tags would take three lines of a summary that has to stay
  // one glance tall.
  return `<span class="pkg-tags">${ecosystem}${repoTag}${memberTag}</span>`;
}

function renderCandidate(candidate: UpgradeCandidate, open: boolean, showRepo = false): string {
  const severity = severityOf(candidate);
  // `pending` is the row a manifest produced before anything looked at it: it
  // has a name and an installed version and nothing else, so everything below
  // that would describe a *result* is left out rather than rendered as zeroes.
  const waiting = candidate.status === 'pending';
  const busy = waiting || candidate.status === 'checking' || candidate.status === 'upgrading';
  const target = versionLabel(candidate, candidate.selected);

  // Keyed by the manifest as well as the name. One package can legitimately
  // appear once per manifest that declares it, and keying on the name alone
  // made those rows share a single remembered open/closed state — so opening
  // the root's `zod` also opened `extension/`'s, which reads as the list having
  // duplicated a row rather than as two packages that genuinely both exist.
  return `<details class="pkg ${severity}" data-key="pkg:${escapeAttr(`${candidate.manifestPath}#${candidate.name}`)}" ${open ? 'open' : ''}>
    <summary>
      <span class="dot ${severity}"></span>
      <span class="pkg-name">
        <b>${escapeHtml(candidate.name)}</b>
        ${workspaceTag(candidate, showRepo)}
        <span class="versions">${escapeHtml(candidate.current)}${
          waiting ? '' : ` <span class="arrow">→</span> ${escapeHtml(candidate.selected)}`
        }</span>
      </span>
      <span class="verdict ${severity}${busy ? ' busy' : ''}">${
        busy ? `<span class="spinner"></span>${escapeHtml(busyLabel(candidate))}` : escapeHtml(shortVerdict(candidate, severity))
      }</span>
    </summary>

    <div class="pkg-body">
      ${
        // Nothing to say yet, and an empty paragraph where the verdict will go
        // is worse than none — it reserves space for a sentence that reads as
        // missing rather than as not written yet.
        waiting ? '' : `<p class="verdict-long">${inlineMarkdown(candidate.error ?? candidate.summary, {})}</p>`
      }
      ${renderVerification(candidate)}
      ${renderRationale(candidate)}
      ${renderGaps(candidate)}

      ${waiting ? '' : `<div class="pkg-target">
        <span class="field-label">Target version</span>
        <button class="ctl bordered" data-action="pickVersion" data-id="${escapeAttr(candidate.id)}" title="Choose which version to check and install">
          <span>${escapeHtml(target)}</span>${ICON_CHEVRON}
        </button>
        <span class="kind">${escapeHtml(candidate.kind)}</span>
        ${
          // Re-checking one package was only possible by re-checking every
          // package, which is a minute of waiting to answer a question about
          // one row — so the question went unasked.
          busy
            ? ''
            : `<button class="ctl icon pkg-recheck" data-action="recheck" data-id="${escapeAttr(candidate.id)}" title="Check ${escapeAttr(candidate.name)} again, including any version published since the scan" aria-label="Re-check ${escapeAttr(candidate.name)}">${ICON_REFRESH}</button>`
        }
      </div>`}

      ${candidate.plan ? renderCandidateDetail(candidate, candidate.plan) : ''}

      <div class="pkg-actions">
        ${
          // Nothing to press while the upgrade is still being tested. Every one
          // of these buttons acts on a conclusion that is a few seconds away
          // from being replaced, and "Upgrade and fix 61 sites" on a row whose
          // verification is about to withdraw all 61 is the exact sequence that
          // made a developer stop trusting the number.
          busy
            ? ''
            : `${renderUpgradeActions(candidate)}
        ${
          candidate.impactCount > 0
            ? `<button class="primary" data-action="fixPackage" data-id="${escapeAttr(candidate.id)}">Upgrade and fix ${candidate.impactCount} site${candidate.impactCount === 1 ? '' : 's'}</button>`
            : ''
        }
        <button data-action="fileIssuePackage" data-id="${escapeAttr(candidate.id)}" title="Create a GitHub issue tracking this upgrade instead of acting on it now">Create issue</button>`
        }
      </div>
    </div>
  </details>`;
}

/**
 * The buttons that install something.
 *
 * The rule this replaces a bug with: **every button names the version it will
 * install, and installs the version it names.** The old pair did neither. The
 * first was disabled unless a version fitted the range already in the
 * manifest — so for a pinned dependency, or any 0.x module whose next release
 * moves the minor, it was disabled permanently and looked broken rather than
 * inapplicable. The second was hard-wired to `latest`, so choosing a target
 * version in the picker changed the summary line and nothing else.
 *
 * Now the primary button follows the selection, and the alternatives appear
 * only when they are genuinely different destinations.
 */
function renderUpgradeActions(candidate: UpgradeCandidate): string {
  const { selected, current, latest, latestMinor } = candidate;

  const major = crossesMajor(current, selected);
  const inRange = selected === candidate.safeLatest;

  const primary = `<button data-action="upgrade" data-id="${escapeAttr(candidate.id)}" data-mode="${inRange ? 'safe' : 'force'}" class="${major ? 'risky' : ''}" title="${
    inRange
      ? `Install ${escapeAttr(selected)}, which satisfies the range already declared in ${escapeAttr(candidate.manifestPath)}`
      : `Install ${escapeAttr(selected)} and widen the range in ${escapeAttr(candidate.manifestPath)}`
  }">
      Upgrade to ${escapeHtml(selected)}${major ? ' (major)' : ''}
    </button>`;

  // Shortcuts, not duplicates: each is rendered only when it would land
  // somewhere the primary button would not.
  const alternatives: string[] = [];

  if (latestMinor && latestMinor !== selected) {
    alternatives.push(
      `<button class="ctl bordered" data-action="selectVersion" data-id="${escapeAttr(candidate.id)}" data-version="${escapeAttr(latestMinor)}" title="Check ${escapeAttr(latestMinor)} — the newest release that stays on ${escapeAttr(majorOf(current))}.x, so no major boundary is crossed">
        Stay on ${escapeHtml(majorOf(current))}.x (${escapeHtml(latestMinor)})
      </button>`,
    );
  }

  if (latest !== selected) {
    alternatives.push(
      `<button class="ctl bordered" data-action="selectVersion" data-id="${escapeAttr(candidate.id)}" data-version="${escapeAttr(latest)}" title="Check ${escapeAttr(latest)}, the newest published release${crossesMajor(current, latest) ? ' — a major version ahead' : ''}">
        Latest (${escapeHtml(latest)})${crossesMajor(current, latest) ? ' — major' : ''}
      </button>`,
    );
  }

  return primary + alternatives.join('');
}

/** The major component of a version, for labelling the "stay on this line" button. */
function majorOf(version: string): string {
  return /^\D*(\d+)/.exec(version)?.[1] ?? version;
}

/** The one-line description of a version, shared by the button and the quick pick. */
export function versionLabel(candidate: UpgradeCandidate, version: string): string {
  const major = crossesMajor(candidate.current, version) ? ', major' : '';
  if (version === candidate.latest) return `${version} — latest${major}`;
  if (version === candidate.safeLatest) return `${version} — within your range`;
  return `${version}${major ? ' — major' : ''}`;
}

/**
 * Whether moving to this version crosses a major boundary.
 *
 * Deliberately a string compare rather than a semver import: this module is
 * dependency-free so the whole panel renders under plain Node in the tests, and
 * "did the first number change" is the entire question being asked.
 */
export function crossesMajor(current: string, target: string): boolean {
  const major = (version: string): number | null => {
    const match = /^\D*(\d+)/.exec(version);
    return match ? Number(match[1]) : null;
  };
  const from = major(current);
  const to = major(target);
  return from !== null && to !== null && to > from;
}

/**
 * What is happening to this package, right now.
 *
 * The scan reports a real phase per package — asking the registry, reading
 * release notes, searching this repository, running `npm run build` — and this
 * is where it is shown. "Checking…" for four minutes is what made a working
 * scan look like a stuck one; it survives only as the fallback for a row whose
 * phase has not been reported yet.
 */
function busyLabel(candidate: UpgradeCandidate): string {
  if (candidate.status === 'upgrading') return 'Installing…';
  return candidate.phase ?? 'Checking…';
}

function shortVerdict(candidate: UpgradeCandidate, severity: UpgradeSeverity): string {
  const verified = candidate.verification?.status === 'passed';
  switch (severity) {
    case 'pending':
      return candidate.phase ?? 'Not checked yet';
    case 'affected':
      return `${candidate.impactCount} site${candidate.impactCount === 1 ? '' : 's'} here`;
    case 'verification-failed':
      return 'Verified breaking';
    case 'upstream-only':
      return verified ? 'Verified safe' : 'Safe here';
    case 'unchecked':
      return 'Not verified';
    case 'clean':
      return verified ? 'Verified safe' : 'Safe';
    case 'error':
      return 'Unknown';
  }
}

/** What Drift could not read, listed under the verdict rather than hidden in a log. */
/**
 * Why this upgrade might be worth taking.
 *
 * Sits directly under the verdict, above the gaps, because it is the half of
 * the answer the panel never used to give: a row that says only "no breaking
 * changes" cannot tell you that the version you are on has a high-severity
 * advisory against it.
 *
 * Only sections with something to say are rendered. A maintenance block reading
 * "the repository is active" on every row is how a panel teaches people to stop
 * looking at it.
 */
function renderRationale(candidate: UpgradeCandidate): string {
  const rationale = candidate.rationale;
  if (!rationale) return '';

  const blocks: string[] = [];

  const { security } = rationale;
  if (security.checked && security.resolved.length > 0) {
    blocks.push(
      renderFacts(
        'good',
        `Fixes ${security.resolved.length} known ${security.resolved.length === 1 ? 'vulnerability' : 'vulnerabilities'}`,
        security.resolved.map((vuln) =>
          advisoryLine(vuln, vuln.fixedIn ? `, first fixed in ${vuln.fixedIn}` : ''),
        ),
      ),
    );
  }
  if (security.checked && security.introduced.length > 0) {
    blocks.push(
      renderFacts(
        'bad',
        `The target version is affected by ${security.introduced.length} ${security.introduced.length === 1 ? 'advisory' : 'advisories'} the installed version is not`,
        security.introduced.map((vuln) => advisoryLine(vuln, '')),
      ),
    );
  }

  const concerning = rationale.maintenance.facts.filter((fact) => fact.concerning);
  if (concerning.length > 0) {
    blocks.push(renderFacts('bad', 'Maintenance', concerning.map((fact) => fact.statement)));
  }

  if (rationale.license.verdict === 'policy-violation' || rationale.license.verdict === 'unknown') {
    blocks.push(
      renderFacts(
        rationale.license.verdict === 'policy-violation' ? 'bad' : 'neutral',
        rationale.license.verdict === 'policy-violation' ? 'License review required' : 'License',
        [rationale.license.statement],
      ),
    );
  }

  if (rationale.improvements.length > 0) {
    blocks.push(
      renderFacts('neutral', 'Other improvements', rationale.improvements.map((i) => i.statement)),
    );
  }

  return blocks.join('');
}

/**
 * One advisory, with the identifier as a link to the advisory itself.
 *
 * Drift names `GO-2026-5024` and states a severity, and the developer's next
 * question is always "says who, and what does it actually let an attacker do".
 * OSV gives every record a URL and the assessment has carried it all along;
 * printing the identifier as dead text made the reader go and search for a
 * string Drift already had a link to.
 */
function advisoryLine(vuln: Vulnerability, suffix: string): { html: string } {
  const severity = vuln.severity === 'unknown' ? '' : ` — ${escapeHtml(vuln.severity)}`;
  const aliases = vuln.aliases.length > 0 ? ` <span class="hint">(${escapeHtml(vuln.aliases.slice(0, 2).join(', '))})</span>` : '';

  return {
    html:
      `<a data-action="openUrl" data-url="${escapeAttr(vuln.url)}" title="${escapeAttr(vuln.summary)}">${escapeHtml(vuln.id)}</a>` +
      `${severity}${escapeHtml(suffix)}${aliases}`,
  };
}

/** A fact list. Items are escaped unless they arrive pre-rendered as `{ html }`. */
function renderFacts(
  tone: 'good' | 'bad' | 'neutral',
  heading: string,
  items: readonly (string | { html: string })[],
): string {
  if (items.length === 0) return '';
  const MAX = 5;
  const shown = items.slice(0, MAX);
  const hidden = items.slice(MAX);

  return `<div class="rationale ${tone}">
    <span class="rationale-heading">${escapeHtml(heading)}</span>
    <ul>${shown
      .map((item) => `<li>${renderFactItem(item)}</li>`)
      .join('')}${hidden.length > 0 ? renderMoreFacts(tone, heading, hidden) : ''}</ul>
  </div>`;
}

function renderFactItem(item: string | { html: string }): string {
  return typeof item === 'string' ? escapeHtml(item) : item.html;
}

function renderMoreFacts(
  tone: 'good' | 'bad' | 'neutral',
  heading: string,
  items: readonly (string | { html: string })[],
): string {
  const fingerprint = items.map((item) => (typeof item === 'string' ? item : item.html)).join('\n');
  return `<li class="hint"><details class="fact-more" data-key="facts:${escapeAttr(tone)}:${escapeAttr(heading)}:${stableHash(fingerprint)}">
    <summary>…and ${items.length} more</summary>
    <ul>${items.map((item) => `<li>${renderFactItem(item)}</li>`).join('')}</ul>
  </details></li>`;
}

function stableHash(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * What the project's own toolchain said about this upgrade.
 *
 * The single most important line on the card, because it is the only one that
 * was measured rather than predicted — Drift installed this version in a
 * throwaway worktree and ran the repository's typecheck, build and tests
 * against it.
 *
 * A skip is stated as loudly as a pass. The failure this exists to prevent is
 * a row that quietly shows unverified predictions as though they were checked,
 * and then gets contradicted the moment someone presses Fix.
 */
function renderVerification(candidate: UpgradeCandidate): string {
  if (candidate.status === 'checking') {
    return `<p class="verification pending">${ICON_ALERT}<span>Installing this version and running your checks against it. The findings below are predictions until that finishes.</span></p>`;
  }

  const verification = candidate.verification;
  if (!verification) {
    // Quick Scan's own state: static analysis ran, nothing has been
    // installed or run yet. A small note plus the one action that moves this
    // row into Deep Verification, rather than leaving the absence of a
    // verification block to be read as "nothing to say".
    return `<p class="verification unverified"><span>Static analysis only — not deeply verified.</span>
      <button class="ctl bordered" data-action="verifyOne" data-id="${escapeAttr(candidate.id)}" title="Install ${escapeAttr(candidate.name)} in a throwaway worktree and run this project's own checks against it">Deep Verify</button></p>`;
  }

  const ran = verification.checks
    .filter((check) => check.status === 'passed' || check.status === 'failed')
    .map((check) => `<code>${escapeHtml(check.label)}</code> ${check.status}`)
    .join(' · ');

  if (verification.status === 'passed') {
    return `<p class="verification passed"><span>Verified against your project: ${ran}. Anything a compiler could have caught has been ruled out — what remains, if anything, is behaviour no check can see.</span></p>`;
  }

  if (verification.status === 'failed') {
    return `<p class="verification failed">${ICON_ALERT}<span>This upgrade breaks your project: ${ran}. Measured, not predicted.</span></p>
    ${renderVerificationDiagnostics(candidate.id, verification.checks)}`;
  }

  // `describeUnusableBaseline` (and similar reasons) fold the actual command
  // and its output into this string as `sentence\n\n$ command\noutput`, so a
  // reader can tell a genuine break from the worktree just missing a file.
  // Split it back apart here rather than dumping the whole thing into one
  // paragraph, where a multi-line build log read as an unbroken wall of text.
  const [summary, ...detailParts] = (verification.reason ?? 'Drift could not test this upgrade.').split('\n\n');
  const detail = detailParts.join('\n\n');
  return `<p class="verification skipped">${ICON_ALERT}<span>Could not verify — ${escapeHtml(summary ?? '')} The findings below are static predictions.</span>
    <button class="ctl bordered" data-action="verifyOne" data-id="${escapeAttr(candidate.id)}" title="Try Deep Verification again">Try Deep Verify Again</button></p>
  ${detail ? `<pre class="activity-io"><code>${escapeHtml(detail)}</code></pre>` : ''}`;
}

/**
 * The command and its actual output, for the checks that failed.
 *
 * `renderVerification`'s summary line names which check failed, not why —
 * that reads as Drift's opinion. Whether a build genuinely broke or just
 * failed to run in the throwaway worktree (a missing gitignored file it
 * needs, say) is a question the reader can only answer by seeing what the
 * command actually printed, the same as if they had run it themselves.
 */
function renderVerificationDiagnostics(candidateId: string, checks: readonly CheckOutcome[]): string {
  const failing = checks.filter((check) => check.status === 'failed');
  if (failing.length === 0) return '';

  return `<details class="sub" data-key="verify-diagnostics:${escapeAttr(candidateId)}">
    <summary>Command output</summary>
    ${failing
      .map(
        (check) =>
          `<pre class="activity-io"><span>$ ${escapeHtml(check.label)}</span><code>${escapeHtml(check.output.trim() || '(no output captured)')}</code></pre>`,
      )
      .join('')}
  </details>`;
}

function renderGaps(candidate: UpgradeCandidate): string {
  if (!candidate.gaps?.length) return '';
  return `<ul class="gaps">${candidate.gaps
    .map((gap) => `<li>${ICON_ALERT}<span>${inlineMarkdown(gap, {})}</span></li>`)
    .join('')}</ul>${renderToolRequests(candidate)}`;
}

function renderToolRequests(candidate: UpgradeCandidate): string {
  const requests = candidate.toolRequests ?? [];
  if (requests.length === 0) return '';
  return `<div class="tool-requests">${requests
    .map(
      (request) =>
        `<span>${escapeHtml(toolRequestReason(request.id))}</span><button class="ctl bordered" data-action="installTool" data-id="${escapeAttr(candidate.id)}" data-value="${escapeAttr(request.id)}" title="Ask Drift to run ${escapeAttr([request.command, ...request.args].join(' '))}">${escapeHtml(request.label)}</button>`,
    )
    .join('')}</div>`;
}

function toolRequestReason(id: string): string {
  if (id === 'cargo-public-api') {
    return 'Optional helper: lets Drift compare Rust public APIs instead of relying on changelog and semver evidence alone.';
  }
  if (id === 'japicmp') {
    return 'Optional helper: lets Drift compare published JVM APIs instead of relying on changelog and semver evidence alone.';
  }
  if (id === 'rustup-nightly') {
    return 'Optional helper: `cargo public-api` needs the Rust nightly toolchain to read rustdoc\'s JSON output.';
  }
  return 'Optional helper: lets Drift gather stronger evidence for this upgrade.';
}

function renderCandidateDetail(candidate: UpgradeCandidate, plan: RemediationPlan): string {
  const matched = plan.breakingChanges.filter((change) =>
    plan.impactSites.some((site) => site.breakingChangeId === change.id),
  );
  const unmatched = plan.breakingChanges.filter(
    (change) => !plan.impactSites.some((site) => site.breakingChangeId === change.id),
  );

  return `<div class="detail">
    ${matched.map((change) => renderBreak(candidate, change, plan, true)).join('')}

    ${
      unmatched.length
        ? `<details class="sub" data-key="unmatched:${escapeAttr(candidate.name)}">
            <summary>${unmatched.length} upstream change${unmatched.length === 1 ? '' : 's'} that ${unmatched.length === 1 ? 'does' : 'do'} not touch your code</summary>
            <p class="hint">Drift found ${unmatched.length === 1 ? 'this' : 'these'} in the release notes, then searched this repository for the affected APIs and found nothing. Listed so you can check the reasoning, not because there is anything to do.</p>
            ${unmatched.map((change) => renderBreak(candidate, change, plan, false)).join('')}
          </details>`
        : ''
    }

    ${
      plan.evidence.length
        ? `<details class="sub" data-key="evidence:${escapeAttr(candidate.name)}">
            <summary>Evidence Drift read <small>${plan.evidence.length} source${plan.evidence.length === 1 ? '' : 's'}</small></summary>
            ${renderEvidence(candidate, plan.evidence)}
          </details>`
        : ''
    }
  </div>`;
}

function renderBreak(
  candidate: UpgradeCandidate,
  change: BreakingChange,
  plan: RemediationPlan,
  expanded: boolean,
): string {
  const sites = plan.impactSites.filter((site) => site.breakingChangeId === change.id);
  const evidence = plan.evidence.filter((entry) => change.citations.includes(entry.id));
  const diff = diffContextFor(candidate, change.symbols[0]);
  const confidence = confidenceDisplay(change);

  return `<details class="break" data-key="brk:${escapeAttr(change.id)}" ${expanded ? 'open' : ''}>
    <summary>
      <span class="confidence ${confidence.band}">${escapeHtml(confidence.text)}</span>
      <span class="break-summary">${inlineMarkdown(change.summary, {})}</span>
    </summary>
    <div class="break-body">
      ${change.symbols.length ? `<p class="symbols">${change.symbols.map((s) => `<code>${escapeHtml(s)}</code>`).join(' ')}</p>` : ''}
      ${
        // The declaration itself, before and after — the actual evidence for
        // the summary above, scoped to just this change rather than the
        // dependency's full evidence dump below. "View diff" answers the
        // question a before/after pair always raises next: show me that
        // properly — this change, in the editor's own diff view, widened to
        // the surrounding published source where it can be fetched. The whole
        // release's diff is a different question, and stays on the
        // semver-heuristic record below where it was the question being asked.
        change.before && change.after && change.before !== change.after
          ? renderBeforeAfter(change.before, change.after, {
              title: change.symbols[0] ?? candidate.name,
              ...diff,
            })
          : ''
      }
      <div class="fix"><b>Fix:</b> <div class="markdown fix-body">${renderMarkdown(change.remediation, { diff })}</div></div>
      ${
        sites.length
          ? `<ul class="sites">${sites
              .slice(0, 20)
              .map(
                (site) =>
                  `<li><a data-action="openFile" data-file="${escapeAttr(site.file)}" data-line="${site.line}"><code>${escapeHtml(site.file)}:${site.line}</code></a><code class="excerpt">${highlightCode(site.excerpt, diff.language)}</code></li>`,
              )
              .join('')}${sites.length > 20 ? `<li class="hint">…and ${sites.length - 20} more</li>` : ''}</ul>`
          : ''
      }
      ${evidence.length ? renderEvidence(candidate, evidence) : ''}
    </div>
  </details>`;
}

/** The package coordinates any before/after under this candidate can be diffed against. */
function diffContextFor(candidate: UpgradeCandidate, symbol?: string): DiffContext {
  return {
    language: languageForEcosystem(candidate.ecosystem),
    source: {
      ecosystem: candidate.ecosystem,
      name: candidate.name,
      from: candidate.current,
      to: candidate.selected,
    },
    ...(symbol ? { symbol } : {}),
  };
}

/**
 * Every source cited for one dependency, each its own collapsed section.
 *
 * `semver-heuristic` gets a second action beyond its citation link: the
 * semver spec explains *why* a patch bump is usually safe, but says nothing
 * about *this* one. "View diff" is Drift's answer to the question a reader
 * actually has — fetches the two published versions and opens them in the
 * editor's own diff view, rather than asking the reader to go find them.
 */
function renderEvidence(candidate: UpgradeCandidate, evidence: readonly Evidence[]): string {
  return `<div class="evidence">
    ${evidence
      .map(
        (entry) => `<details data-key="ev:${escapeAttr(entry.id)}">
          <summary>
            <span class="source">${escapeHtml(entry.source)}</span>
            ${
              entry.url
                ? `<a data-action="openUrl" data-url="${escapeAttr(entry.url)}">${escapeHtml(entry.title)}</a>`
                : `<span>${escapeHtml(entry.title)}</span>`
            }
            ${
              entry.source === 'semver-heuristic'
                ? `<button class="ctl bordered" data-action="openVersionDiff" data-id="${escapeAttr(candidate.id)}" title="Fetch ${escapeAttr(candidate.name)} ${escapeAttr(candidate.current)} and ${escapeAttr(candidate.selected)} and open a real diff between them">View diff</button>`
                : ''
            }
          </summary>
          <div class="markdown quote">${renderMarkdown(entry.content, {
            ...(entry.url ? { baseUrl: entry.url } : {}),
            // Every before/after inside this record belongs to the same
            // package, so each pair offers the same "view diff" the findings
            // above do.
            diff: diffContextFor(candidate),
          })}</div>
        </details>`,
      )
      .join('')}
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Changes waiting for review                                          */
/* ------------------------------------------------------------------ */

/**
 * The change list.
 *
 * A table of contents for edits that are already in the working tree, with the
 * same Keep / Undo vocabulary the editor uses so the two surfaces read as one
 * feature. Every row opens the real diff editor, because that is where a change
 * can actually be judged.
 */
function renderChanges(title: string, vm: ViewModel): string {
  const review = vm.review;
  if (!review || review.totals.files === 0) {
    return `<div class="notice success">${ICON_CHECK}<div class="markdown"><p>All changes resolved. Nothing is waiting for review.</p></div></div>`;
  }

  const { totals } = review;

  return `<div class="changes">
    <div class="changes-head">
      <div>
        <b>${escapeHtml(title)}</b>
        <small>${totals.files} file${totals.files === 1 ? '' : 's'} · ${totals.hunks} change${totals.hunks === 1 ? '' : 's'} · <span class="add">+${totals.added}</span> <span class="del">−${totals.removed}</span></small>
      </div>
      <div class="changes-actions">
        <button data-action="undoAll" title="Restore every file to how it was">Undo all</button>
        <button class="primary" data-action="keepAll" title="Accept everything and commit each group">Keep all</button>
      </div>
    </div>
    <p class="hint">Nothing is committed yet. Keeping a whole group commits it on its own, exactly as the plan described.</p>

    ${review.groups
      .filter((group) => group.files.length > 0 || group.committed)
      .map((group) => renderChangeGroup(group))
      .join('')}
  </div>`;
}

function renderChangeGroup(group: ReviewGroup): string {
  if (group.committed) {
    return `<div class="change-group committed">
      <div class="group-head">
        ${ICON_COMMIT}
        <div><b>${escapeHtml(group.title)}</b><small>Committed as ${escapeHtml(group.committed.sha.slice(0, 7))} on ${escapeHtml(group.committed.branch)}</small></div>
      </div>
    </div>`;
  }

  return `<div class="change-group${group.commitError ? ' commit-error' : ''}">
    <div class="group-head">
      ${ICON_DIFF}
      <div><b>${escapeHtml(group.title)}</b><small>${group.files.length} file${group.files.length === 1 ? '' : 's'}</small></div>
      <div class="group-actions">
        ${
          group.commitError
            ? `<button class="primary" data-action="retryCommit" data-order="${group.order}">Retry commit</button>`
            : `<button data-action="undoGroup" data-order="${group.order}">Undo</button>
        <button data-action="keepGroup" data-order="${group.order}">Keep &amp; commit</button>`
        }
      </div>
    </div>
    ${group.commitError ? `<p class="hint error">Commit failed: ${escapeHtml(group.commitError)}. Your accepted changes are still here.</p>` : ''}
    ${group.files
      .map(
        (file) => `<div class="change-file">
          <a class="path" data-action="openDiff" data-path="${escapeAttr(file.path)}" title="Open the diff">
            ${ICON_FILE}<span>${escapeHtml(file.path)}</span>
          </a>
          <span class="stat"><span class="add">+${file.stat.added}</span> <span class="del">−${file.stat.removed}</span></span>
          <span class="hunks">${file.hunks.length} change${file.hunks.length === 1 ? '' : 's'}</span>
          <span class="file-actions">
            <button data-action="undoFile" data-path="${escapeAttr(file.path)}" title="Restore this file">Undo</button>
            <button data-action="keepFile" data-path="${escapeAttr(file.path)}" title="Accept every change in this file">Keep</button>
          </span>
        </div>`,
      )
      .join('')}
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Composer                                                           */
/* ------------------------------------------------------------------ */

/**
 * The composer.
 *
 * One menu, opened from the composer and drawn in the composer. Bouncing each
 * choice out to `showQuickPick` was correct about one thing — an OS-drawn
 * `<select>` in a webview is unusable — and wrong about everything else: the
 * quick pick opens at the top of the window, a long way from the button that
 * summoned it, it takes over the whole editor for a two-item choice, and five
 * separate pickers make five separate things to learn. A themed menu anchored to
 * its own trigger is what every other chat extension does, and it is the shape
 * that reads as part of the composer rather than as an interruption of it.
 *
 * The one choice still handed to the host is picking a file, because that is a
 * search across thousands of paths and VS Code's fuzzy path picker is genuinely
 * the better tool for it.
 */
export function renderComposer(vm: ViewModel): string {
  const placeholder = vm.awaitingAnswer
    ? 'Type your answer, or pick an option above…'
    : vm.busy
      ? 'Drift is working…'
      : 'Ask about a dependency, or type / for commands';

  return `<div id="composer-region" class="composer ${vm.awaitingAnswer ? 'answering' : ''}">
    ${
      vm.attachments.length
        ? `<div class="chips">
            ${vm.attachments
              .map(
                (a) =>
                  `<span class="chip">${attachmentIcon(a)}<span class="chip-label">${escapeHtml(a.label)}</span><button data-action="detach" data-value="${escapeAttr(a.value)}" title="Remove" aria-label="Remove ${escapeAttr(a.label)}">${ICON_CLOSE}</button></span>`,
              )
              .join('')}
          </div>`
        : ''
    }

    <div class="commands" id="commands" hidden>
      ${vm.commands
        .map(
          (command) =>
            `<button class="command" data-action="complete" data-command="${escapeAttr(command.name)}">
              <b>${escapeHtml(command.name)}${command.args ? ` <span class="args">${escapeHtml(command.args)}</span>` : ''}</b>
              <small>${escapeHtml(command.description)}</small>
            </button>`,
        )
        .join('')}
    </div>

    <textarea id="input" rows="1" data-token="${vm.draftToken}" placeholder="${escapeAttr(placeholder)}">${escapeHtml(vm.draft)}</textarea>

    ${renderMenu(vm)}

    <div class="composer-bar">
      <button class="ctl icon" data-action="openMenu" data-anchor="context" title="Attach a file, a folder, or the current selection" aria-label="Add context">${ICON_PLUS}</button>

      ${
        // Its own control, between context and tools, labelled with whatever is
        // actually selected. Which model does the work is the setting that most
        // changes the result, and it was reachable only by knowing it lived
        // under the plus — a button whose label named neither.
        `<button class="ctl" data-action="openMenu" data-anchor="${vm.modelLabel ? 'model' : 'model:setup'}" title="${escapeAttr(
          vm.modelLabel
            ? `${vm.agentLabel} · ${vm.modelLabel}. Choose the subscription and model that does the work.`
            : 'No AI agent found yet. Choose one to set up.',
        )}">
          ${ICON_MODEL}<span>${escapeHtml(vm.modelLabel ?? 'Choose agent')}</span>
        </button>`
      }

      <button class="ctl" data-action="openMenu" data-anchor="tools" title="Everything Drift can do: scan, check the last dependency change, upgrade, fix, review">
        ${ICON_TOOLS}<span>Tools</span>
      </button>

      ${
        // Only drawn for agents that actually have a reasoning budget. Effort
        // changes how hard the model thinks and nothing else — never which
        // packages are checked or which fixes are attempted.
        vm.effortLabel
          ? `<button class="ctl" data-action="openMenu" data-anchor="effort" title="${escapeAttr(
              `Effort: ${vm.effortLabel}. How hard ${vm.agentLabel} thinks about each fix.`,
            )}">
              ${ICON_SPEED}<span>${escapeHtml(vm.effortLabel)}</span>
            </button>`
          : ''
      }

      ${
        vm.scopeLabel
          ? `<button class="ctl" data-action="openMenu" data-anchor="scope" title="${escapeAttr(
              `Scanning ${vm.scopeLabel}. More than one repository is open — choose which ones the next scan covers.`,
            )}">
              ${ICON_REPO}<span>${escapeHtml(vm.scopeLabel)}</span>
            </button>`
          : ''
      }

      <span class="spacer"></span>

      ${
        // Where the work lands and whether it gets committed. Drift branched
        // and held changes for review long before this button existed; what it
        // did not do was say so anywhere near the place you start a fix, so the
        // safest behaviour it has was also the least visible.
        `<button class="ctl" data-action="openMenu" data-anchor="git" title="${escapeAttr(
          `${vm.branchMode === 'new' ? 'Fixes start on a new branch' : 'Fixes edit the branch you are on'} · ${
            vm.commitMode === 'auto' ? 'commits automatically' : 'nothing is committed until you keep it'
          }. Also: review every change, or commit now.`,
        )}" aria-label="Git">
          ${ICON_BRANCH}<span>${escapeHtml(vm.branchMode === 'new' ? 'New branch' : 'This branch')}</span>${ICON_CHEVRON}
        </button>`
      }

      <button class="ctl" data-action="openMenu" data-anchor="permission" title="${escapeAttr(
        `${describeMode(vm.mode)} · ${describePermission(vm.permission)}`,
      )}" aria-label="Permissions">
        ${vm.mode === 'agent' ? ICON_SHIELD : ICON_ASK}<span>${escapeHtml(
          vm.mode === 'ask' ? 'Ask only' : describePermissionShort(vm.permission),
        )}</span>${ICON_CHEVRON}
      </button>

      ${
        vm.busy
          ? vm.cancellable
            ? vm.stopping
              ? `<button class="stop stopping" data-action="stop" disabled title="Stopping" aria-label="Stopping"><span class="spinner"></span></button>`
              : // A scan is stoppable like everything else. The risk it used to be
              // locked for is real but belongs to the *result*, not the button:
              // what must never happen is a half-scanned repository presented as
              // a clean bill of health, and that is prevented by labelling the
              // partial result as partial — which `scan()` now does — rather
              // than by refusing to let anyone out of a five-minute wait.
              `<button class="stop" data-action="stop" title="Stop — what has been checked so far is kept, and the rest is reported as unchecked">${ICON_STOP}</button>`
            : `<span class="working" title="Drift is finishing this step." aria-label="Working"><span class="spinner"></span></span>`
          : `<button class="send" data-action="submit" title="Send (Enter)" aria-label="Send">${ICON_SEND}</button>`
      }
    </div>
  </div>`;
}

/**
 * The composer menu.
 *
 * Always in the document, hidden until asked for, so opening it is a class
 * change rather than a round trip to the extension host — and so a re-render
 * mid-scan can put it back exactly as it was.
 *
 * Every control opens the same widget at its own anchor, and only the sections
 * belonging to that anchor are shown. That is what keeps the plus button honest:
 * it offers context and nothing else, because a button that also changes the
 * model is a button whose label is a lie.
 */
function renderMenu(vm: ViewModel): string {
  return `<div class="menu" id="menu" data-anchor="context" hidden>
    <div class="menu-search">
      ${ICON_SEARCH_SMALL}
      <input id="menu-filter" type="text" placeholder="Search…" autocomplete="off" spellcheck="false" aria-label="Search this menu">
    </div>
    <div class="menu-list" id="menu-list">
      ${vm.menu
        .map(
          (section) => `<div class="menu-section" data-section="${escapeAttr(section.id)}" data-anchor="${escapeAttr(section.anchor)}">
            <div class="menu-title">${escapeHtml(section.title)}</div>
            ${section.slider ? renderSlider(section.slider) : ''}
            ${section.items.map(renderMenuItem).join('')}
          </div>`,
        )
        .join('')}
      <div class="menu-empty" hidden>Nothing matches.</div>
    </div>
  </div>`;
}

/**
 * The effort dial.
 *
 * Drawn from the selected model's own stops, so the track never offers a
 * position the model cannot honour. The label under it changes as the handle
 * moves and says what that position actually does to the model, because "high"
 * means nothing on its own — "thinks harder on each change" does.
 *
 * Each label is placed at the centre of the handle's position for that stop
 * rather than spread evenly across the row. Those are not the same points: a
 * handle travels between `thumb/2` and `width - thumb/2`, so evenly spaced
 * labels drift away from the thing they name, worst in the middle. The track is
 * inset far enough that the first and last labels have room to sit centred
 * without hanging off the menu.
 */
function renderSlider(slider: MenuSlider): string {
  const current = slider.stops[slider.value] ?? slider.stops[0]!;
  const last = slider.stops.length - 1;

  return `<div class="slider" data-slider="${escapeAttr(slider.id)}">
    <input
      type="range"
      id="slider-${escapeAttr(slider.id)}"
      min="0"
      max="${last}"
      step="1"
      value="${slider.value}"
      data-action="slider"
      data-id="${escapeAttr(slider.id)}"
      data-values="${escapeAttr(slider.stops.map((stop) => stop.value).join(','))}"
      aria-label="${escapeAttr(slider.id)}">
    <div class="slider-ticks">
      ${slider.stops
        .map(
          (stop, index) =>
            `<span class="${index === slider.value ? 'on' : ''}" style="left:${stopCentre(index, last)}">${escapeHtml(stop.label)}</span>`,
        )
        .join('')}
    </div>
    <p class="slider-detail" id="slider-detail-${escapeAttr(slider.id)}" data-details="${escapeAttr(
      slider.stops.map((stop) => stop.detail).join('|'),
    )}">${escapeHtml(current.detail)}</p>
  </div>`;
}

/**
 * Where the handle's centre sits at a given stop, as a CSS length.
 *
 * The handle travels the track minus its own width, starting half a handle in —
 * so this is that same arithmetic, in `calc`, against whatever width the menu
 * turns out to be. The label is then pulled back by half its own width in CSS,
 * which puts its centre exactly over the circle's.
 */
function stopCentre(index: number, last: number): string {
  const fraction = last > 0 ? index / last : 0.5;
  return `calc(var(--inset) + var(--thumb) / 2 + (100% - 2 * var(--inset) - var(--thumb)) * ${fraction.toFixed(4)})`;
}

function renderMenuItem(item: MenuItem): string {
  const search = `${item.label} ${item.detail ?? ''} ${item.hint ?? ''} ${item.keywords ?? ''}`.toLowerCase();
  const opens = item.submenu
    ? `data-action="openMenu" data-anchor="${escapeAttr(item.submenu)}"`
    : `data-action="menu" data-id="${escapeAttr(item.id)}"`;

  return `<button class="menu-item ${item.checked ? 'checked' : ''}" ${opens} data-search="${escapeAttr(search)}">
    <span class="menu-check">${item.checked ? ICON_CHECK : ''}</span>
    <span class="menu-icon">${item.icon ? MENU_ICONS[item.icon] : ''}</span>
    <span class="menu-text">
      <b>${escapeHtml(item.label)}</b>
      ${item.detail ? `<small>${escapeHtml(item.detail)}</small>` : ''}
    </span>
    ${item.hint ? `<span class="menu-hint">${escapeHtml(item.hint)}</span>` : ''}
    ${
      // A trailing chevron means "there is more this way". On a row that goes
      // back it points the wrong way at nothing: "All subscriptions" drew a
      // left arrow and a right arrow at once, each claiming a different
      // destination for the same click.
      item.submenu && item.icon !== 'back' ? `<span class="menu-more">${ICON_CHEVRON_RIGHT}</span>` : ''
    }
  </button>`;
}

function attachmentIcon(attachment: Attachment): string {
  switch (attachment.kind) {
    case 'folder':
      return ICON_FOLDER;
    case 'package':
      return ICON_PACKAGE;
    case 'selection':
      return ICON_SELECTION;
    default:
      return ICON_FILE;
  }
}

function noticeIcon(tone: string): string {
  switch (tone) {
    case 'warn':
      return ICON_ALERT;
    case 'error':
      return ICON_ERROR;
    case 'success':
      return ICON_CHECK;
    default:
      return ICON_INFO;
  }
}

/* ------------------------------------------------------------------ */
/* Markdown + escaping                                                 */
/* ------------------------------------------------------------------ */

/**
 * Where a before/after pair found in prose can be diffed to.
 *
 * Everything is optional because the pair itself is always enough to diff:
 * with a package and a symbol the editor can show the change in its real
 * surroundings, and without them it shows the two declarations, which is still
 * the question the reader asked.
 */
export interface DiffContext {
  title?: string;
  symbol?: string;
  language?: string;
  source?: { ecosystem: string; name: string; from: string; to: string };
}

interface MarkdownOptions {
  baseUrl?: string;
  /** Package context for any before/after pair inside this block of prose. */
  diff?: DiffContext;
}

export function renderMarkdown(text: string, options: MarkdownOptions = {}): string {
  const out: string[] = [];
  let inList = false;
  let inCode = false;
  let code: string[] = [];
  /** The most recent prose line, which names the symbol a following pair belongs to. */
  let lastProse = '';
  /** A `before:` waiting for the `after:` that pairs with it. */
  let pendingBefore: string | null = null;
  let pendingTitle = '';

  const closeList = () => {
    if (!inList) return '';
    inList = false;
    return '</ul>';
  };

  /** A `before:` with no `after:` after it is still a snippet worth showing. */
  const flushPending = () => {
    if (pendingBefore === null) return '';
    const only = codeFigure('before', pendingBefore, options.diff?.language);
    pendingBefore = null;
    return only;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();

    if (line.startsWith('```')) {
      if (inCode) {
        out.push(`<pre><code>${highlightCode(code.join('\n'), options.diff?.language)}</code></pre>`);
        code = [];
        inCode = false;
      } else {
        out.push(flushPending(), closeList());
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      code.push(raw);
      continue;
    }

    if (!line) {
      out.push(flushPending(), closeList());
      continue;
    }

    // A `before:`/`after:` pair is one thing, not two: rendered together, with
    // the button that opens exactly that change in the editor's diff view —
    // which is what makes every before/after Drift prints, wherever it prints
    // it, offer the same next step.
    const labelledCode = /^(before|after):\s*(.*)$/i.exec(line);
    if (labelledCode) {
      const label = labelledCode[1]!.toLowerCase();
      const body = labelledCode[2]!;
      if (label === 'before') {
        out.push(flushPending(), closeList());
        pendingBefore = body;
        pendingTitle = lastProse;
        continue;
      }
      if (pendingBefore === null) {
        out.push(closeList(), codeFigure('after', body, options.diff?.language));
        continue;
      }
      out.push(
        renderBeforeAfter(pendingBefore, body, {
          ...options.diff,
          ...(pendingTitle ? { title: pendingTitle } : {}),
          ...(options.diff?.symbol ?? symbolIn(pendingTitle)
            ? { symbol: options.diff?.symbol ?? symbolIn(pendingTitle)! }
            : {}),
        }),
      );
      pendingBefore = null;
      continue;
    }

    out.push(flushPending());
    lastProse = line.replace(/^[-*]\s+/, '');

    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      out.push(closeList(), `<h4>${inlineMarkdown(heading[2]!, options)}</h4>`);
      continue;
    }

    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inlineMarkdown(bullet[1]!, options)}</li>`);
      continue;
    }

    out.push(closeList(), `<p>${inlineMarkdown(line, options)}</p>`);
  }

  if (inCode && code.length) {
    out.push(`<pre><code>${highlightCode(code.join('\n'), options.diff?.language)}</code></pre>`);
  }
  out.push(flushPending(), closeList());
  return out.filter(Boolean).join('');
}

/**
 * A before/after pair, full width, with the one action it always implies.
 *
 * The button sits in its own header row rather than beside the code: laying
 * them out side by side squeezes the declarations into whatever width the
 * button leaves over, which is exactly where they need the room.
 */
export function renderBeforeAfter(before: string, after: string, context: DiffContext): string {
  return `<div class="compare">
    <div class="compare-head">
      <span class="compare-label">before / after</span>
      ${renderDiffButton(before, after, context)}
    </div>
    ${codeFigure('before', before, context.language)}
    ${codeFigure('after', after, context.language)}
  </div>`;
}

function codeFigure(label: string, code: string, language: string | undefined): string {
  return `<figure class="code-compare"><figcaption>${escapeHtml(label)}</figcaption><pre><code>${highlightCode(
    code,
    language,
  )}</code></pre></figure>`;
}

/**
 * The button that opens this one change in the editor's diff view.
 *
 * The whole request travels in `data-value` as JSON: the panel's click handler
 * forwards that field verbatim, so no new plumbing is needed for a payload
 * that is richer than an id.
 */
function renderDiffButton(before: string, after: string, context: DiffContext): string {
  const request = {
    before,
    after,
    title: context.title ?? context.symbol ?? context.source?.name ?? 'change',
    ...(context.language ? { language: context.language } : {}),
    ...(context.symbol ? { symbol: context.symbol } : {}),
    ...(context.source ? { source: context.source } : {}),
  };
  return `<button class="ctl bordered" data-action="openFindingDiff" data-value="${escapeAttr(
    JSON.stringify(request),
  )}" title="Open just this change in the editor's diff view">View diff</button>`;
}

/** The first identifier-shaped word in a line, which is what a pair is about. */
function symbolIn(text: string): string | null {
  return /`([^`]+)`/.exec(text)?.[1] ?? /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\b/.exec(text)?.[1] ?? null;
}

function inlineMarkdown(text: string, options: MarkdownOptions): string {
  const out: string[] = [];
  const links = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (const match of text.matchAll(links)) {
    const start = match.index ?? 0;
    out.push(inlineText(text.slice(last, start)));
    const label = match[1]!;
    const href = resolveMarkdownHref(match[2]!, options.baseUrl);
    out.push(
      href
        ? `<a data-action="openUrl" data-url="${escapeAttr(href)}">${inlineText(label)}</a>`
        : inlineText(match[0]!),
    );
    last = start + match[0]!.length;
  }
  out.push(inlineText(text.slice(last)));
  return out.join('');
}

function inlineText(text: string): string {
  return autolink(
    escapeHtml(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1<em>$2</em>'),
  );
}

/**
 * Bare URLs, turned into links.
 *
 * Drift's own evidence writes plain URLs rather than markdown links — the
 * declaration sources on a type-surface record, for one — and a URL rendered
 * as unclickable text in a panel is a URL nobody follows. Runs already inside
 * a tag are skipped so a markdown link's `href` is not re-linked inside
 * itself. `url` is a run of already-escaped HTML, so it is safe in both the
 * attribute and the text without a second pass of escaping (which would turn
 * a query string's `&amp;` into `&amp;amp;`).
 */
function autolink(html: string): string {
  return html.replace(
    /(<[^>]*>)|(https?:\/\/[^\s<>"')\]]+)/g,
    (_match, tag: string | undefined, url: string | undefined) =>
      tag ?? `<a data-action="openUrl" data-url="${url}">${url}</a>`,
  );
}

function resolveMarkdownHref(href: string, baseUrl: string | undefined): string | null {
  const target = href.trim().replace(/^<(.+)>$/, '$1');
  if (/^https?:\/\//i.test(target)) return target;
  if (!baseUrl || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  try {
    return new URL(target, baseUrl).toString();
  } catch {
    return null;
  }
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/'/g, '&#39;');
}

export function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i += 1) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

/* ------------------------------------------------------------------ */
/* Icons — inline so the CSP needs no image or font source             */
/* ------------------------------------------------------------------ */

const svg = (body: string, size = 14): string =>
  `<svg class="i" width="${size}" height="${size}" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">${body}</svg>`;

/** The same, drawn as a line. For glyphs a filled shape makes too heavy. */
const stroke = (body: string, size = 14, width = 1.3): string =>
  `<svg class="i" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const LOGO = `<svg width="34" height="34" viewBox="0 0 32 32" fill="none" aria-hidden="true">
  <path d="M4 22c5-1 7-12 12-12s7 11 12 10" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
  <circle cx="16" cy="10" r="2.6" fill="currentColor"/>
</svg>`;

const LOGO_SMALL = `<svg class="i" width="14" height="14" viewBox="0 0 32 32" fill="none" aria-hidden="true">
  <path d="M4 22c5-1 7-12 12-12s7 11 12 10" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
</svg>`;

const ICON_CHECK = svg('<path d="M6.2 11.4 3.4 8.6l-1 1L6.2 13.4 14 5.6l-1-1z"/>');
const ICON_ERROR = svg('<path d="M8 1.5A6.5 6.5 0 1 0 8 14.5 6.5 6.5 0 0 0 8 1.5zm.75 9.75h-1.5v-1.5h1.5v1.5zm0-2.5h-1.5V4.5h1.5v4.25z"/>');
const ICON_ALERT = svg('<path d="M8 1.5 15 14H1L8 1.5zm-.75 5v3.5h1.5V6.5h-1.5zm0 4.5V12h1.5v-1h-1.5z"/>');
const ICON_INFO = svg('<path d="M8 1.5A6.5 6.5 0 1 0 8 14.5 6.5 6.5 0 0 0 8 1.5zM8.75 12h-1.5V7h1.5v5zm0-6h-1.5V4.5h1.5V6z"/>');
const ICON_FILE = svg('<path d="M9.5 1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4.5L9.5 1zm0 1.6L11.4 4.5H9.5V2.6z"/>');
const ICON_FOLDER = svg('<path d="M1.5 3h4l1.2 1.5h7.8V13H1.5V3z"/>');
const ICON_PACKAGE = svg('<path d="M8 1 2 4v8l6 3 6-3V4L8 1zm0 1.7 4 2L8 6.8 4 4.7l4-2z"/>');
const ICON_SELECTION = svg('<path d="M2 2h5v1.5H3.5V7H2V2zm7 0h5v5h-1.5V3.5H9V2zM2 9h1.5v3.5H7V14H2V9zm10.5 0H14v5H9v-1.5h3.5V9z"/>');
const ICON_USER = svg('<path d="M8 2a3 3 0 1 1 0 6 3 3 0 0 1 0-6zm0 7c3 0 5.5 1.6 5.5 3.5V14h-11v-1.5C2.5 10.6 5 9 8 9z"/>');
const ICON_ATTACH = svg('<path d="M8 1.5a2.5 2.5 0 0 1 2.5 2.5v6a4 4 0 0 1-8 0V5H4v5a2.5 2.5 0 0 0 5 0V4a1 1 0 0 0-2 0v6H5.5V4A2.5 2.5 0 0 1 8 1.5z"/>');
/**
 * Send.
 *
 * Drawn as a stroke rather than a filled wedge. A solid arrowhead at this size
 * reads as a heavy, almost warning-shaped blob next to the hairline controls
 * beside it; a thin line matches the weight of the rest of the composer.
 */
const ICON_SEND = stroke('<path d="M8 12.5V3.9M8 3.5l-3.6 3.6M8 3.5l3.6 3.6"/>', 15, 1.3);
const ICON_STOP = svg('<rect x="4.5" y="4.5" width="7" height="7" rx="1.2"/>', 13);
const ICON_SEARCH = svg('<path d="M10.5 9.5 14 13l-1 1-3.5-3.5A5 5 0 1 1 10.5 9.5zM6.5 3a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z"/>', 16);
const ICON_HISTORY = svg('<path d="M8 1.5A6.5 6.5 0 1 0 14.5 8H13A5 5 0 1 1 8 3v2.5L11.5 3.2 8 1V1.5zM7.25 5v4l3.2 1.9.75-1.25L8.75 8.3V5h-1.5z"/>', 16);
const ICON_DIFF = svg('<path d="M4.5 1.5h1.5v3H9v1.5H6v3H4.5v-3h-3V4.5h3v-3zM8 11h6v1.5H8V11z"/>');
const ICON_CHEVRON = svg('<path d="M8 10.2 4.4 6.6l.9-.9L8 8.4l2.7-2.7.9.9L8 10.2z"/>', 12);
const ICON_CHEVRON_RIGHT = svg('<path d="M6.2 3.4 5.3 4.3 9 8l-3.7 3.7.9.9L11 8 6.2 3.4z"/>', 12).replace(
  'class="i"',
  'class="i i-chevron"',
);
const ICON_CLOSE = svg('<path d="M8 6.94 11.06 3.88l1.06 1.06L9.06 8l3.06 3.06-1.06 1.06L8 9.06l-3.06 3.06-1.06-1.06L6.94 8 3.88 4.94l1.06-1.06L8 6.94z"/>', 11);
const ICON_AGENT = svg('<path d="M8 1.2 9 3.3h2.3l-1.2 2 1.2 2H9L8 9.4 7 7.3H4.7l1.2-2-1.2-2H7L8 1.2zM3.5 10.5h9V14h-9v-3.5z"/>', 12);
const ICON_ASK = svg('<path d="M8 1.5a6.5 6.5 0 1 1-3.3 12.1L1.5 14.5l.9-3.2A6.5 6.5 0 0 1 8 1.5z"/>', 12);
const ICON_SHIELD = svg('<path d="M8 1 3 3v4.2c0 3 2.1 5.8 5 6.8 2.9-1 5-3.8 5-6.8V3L8 1z"/>', 12);
const ICON_COMMIT = svg('<path d="M8 5a3 3 0 0 1 2.9 2.25H15v1.5h-4.1A3 3 0 0 1 5.1 8.75H1v-1.5h4.1A3 3 0 0 1 8 5z"/>');
const ICON_PLUS = svg('<path d="M7.25 3h1.5v4.25H13v1.5H8.75V13h-1.5V8.75H3v-1.5h4.25V3z"/>', 15);
const ICON_REWIND = svg('<path d="M8 2.5a5.5 5.5 0 1 1-5.29 7h1.58A4 4 0 1 0 8 4a3.97 3.97 0 0 0-2.83 1.17L7 7H2.5V2.5l1.6 1.6A5.48 5.48 0 0 1 8 2.5z"/>', 12);
const ICON_REFRESH = svg('<path d="M8 3V1L5 3.5 8 6V4a3.5 3.5 0 1 1-3.4 4.35l-1.46.36A5 5 0 1 0 8 3z"/>', 13);
const ICON_SEARCH_SMALL = svg('<path d="M10.5 9.5 14 13l-1 1-3.5-3.5A5 5 0 1 1 10.5 9.5zM6.5 3a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z"/>', 12);
const ICON_UPLOAD = svg('<path d="M8 1.5 12 5.5h-2.75v4h-2.5v-4H4L8 1.5zM2.5 11h11v3.5h-11V11z"/>', 13);
const ICON_GEAR = svg('<path d="M8 5.5A2.5 2.5 0 1 0 8 10.5 2.5 2.5 0 0 0 8 5.5zm6 3.1V7.4l-1.6-.3a4.6 4.6 0 0 0-.5-1.2l.9-1.3-.9-.9-1.3.9a4.6 4.6 0 0 0-1.2-.5L9.1 2H6.9l-.3 1.6a4.6 4.6 0 0 0-1.2.5l-1.3-.9-.9.9.9 1.3a4.6 4.6 0 0 0-.5 1.2L2 7.4v2.2l1.6.3c.1.4.3.8.5 1.2l-.9 1.3.9.9 1.3-.9c.4.2.8.4 1.2.5l.3 1.6h2.2l.3-1.6c.4-.1.8-.3 1.2-.5l1.3.9.9-.9-.9-1.3c.2-.4.4-.8.5-1.2l1.6-.3z"/>', 13);
const ICON_CHECKLIST = svg('<path d="M2 3.5 3.4 5 6 2.4l-.9-.9L3.4 3.2 2.9 2.6 2 3.5zm0 6L3.4 11 6 8.4l-.9-.9L3.4 9.2l-.5-.6L2 9.5zM7.5 3h6.5v1.5H7.5V3zm0 6h6.5v1.5H7.5V9z"/>', 13);
const ICON_REPO = svg(
  '<path d="M4 1.5h8A1.5 1.5 0 0 1 13.5 3v10A1.5 1.5 0 0 1 12 14.5H4A1.5 1.5 0 0 1 2.5 13V3A1.5 1.5 0 0 1 4 1.5zm0 1.5A.5.5 0 0 0 3.5 3v10a.5.5 0 0 0 .5.5h8a.5.5 0 0 0 .5-.5V3a.5.5 0 0 0-.5-.5H4zM5 5h6v1.3H5V5zm0 2.6h6V9H5V7.6zm0 2.6h4v1.3H5v-1.3z"/>',
  13,
);
const ICON_DASH = svg('<path d="M3.5 7.25h9v1.5h-9z"/>', 11);
const ICON_BACK = svg('<path d="M6.8 3.4 7.7 4.3 5 7h9v1.5H5l2.7 2.7-.9.9L2.6 7.75 6.8 3.4z"/>', 12);
const ICON_SPEED = svg('<path d="M8 2.5A6.5 6.5 0 0 0 2.2 12h11.6A6.5 6.5 0 0 0 8 2.5zm2.9 3.1L8.9 9a1.1 1.1 0 1 1-1-1l3-2.4z"/>', 13);
const ICON_LINK = svg('<path d="M6.6 9.4a2.6 2.6 0 0 1 0-3.7l2-2a2.6 2.6 0 0 1 3.7 3.7l-.9.9-1-1 .9-.9a1.2 1.2 0 0 0-1.7-1.7l-2 2a1.2 1.2 0 0 0 0 1.7l-1 1zm2.8-2.8a2.6 2.6 0 0 1 0 3.7l-2 2a2.6 2.6 0 0 1-3.7-3.7l.9-.9 1 1-.9.9a1.2 1.2 0 0 0 1.7 1.7l2-2a1.2 1.2 0 0 0 0-1.7l1-1z"/>', 11);
/** The git control: a branch. */
const ICON_BRANCH = svg('<path d="M5 2.5a2 2 0 0 1 .75 3.85v3.3A2 2 0 1 1 4.25 9.65v-3.3A2 2 0 0 1 5 2.5zm6 0a2 2 0 0 1 .6 3.91C11.4 8.6 9.9 9.6 8 9.9v-1.5c1.5-.3 2.4-1 2.6-2A2 2 0 0 1 11 2.5z"/>', 13);
/** A chip, for the model doing the work. */
const ICON_MODEL = svg(
  '<path d="M6 1.5h4v1.2h1.3A1.5 1.5 0 0 1 12.8 4.2v1.3H14v1.2h-1.2v2.6H14v1.2h-1.2v1.3a1.5 1.5 0 0 1-1.5 1.5H10V14.5H8.8v-1.2H7.2v1.2H6v-1.2H4.7a1.5 1.5 0 0 1-1.5-1.5v-1.3H2V9.3h1.2V6.7H2V5.5h1.2V4.2a1.5 1.5 0 0 1 1.5-1.5H6V1.5zm-.5 4v5h5v-5h-5z"/>',
  13,
);
const ICON_TOOLS = svg('<path d="M10.7 1.5a4 4 0 0 0-3.6 5.7L1.8 12.5l1.7 1.7 5.3-5.3a4 4 0 0 0 5-5.2L11.6 5.5 10 3.9l2.8-2.2a4 4 0 0 0-2.1-.2z"/>', 13);
const ICON_HISTORY_SMALL = svg('<path d="M8 1.5A6.5 6.5 0 1 0 14.5 8H13A5 5 0 1 1 8 3v2.5L11.5 3.2 8 1V1.5zM7.25 5v4l3.2 1.9.75-1.25L8.75 8.3V5h-1.5z"/>', 13);

/** Icons the menu may use, named rather than passed as markup. */
const MENU_ICONS = {
  file: ICON_FILE,
  folder: ICON_FOLDER,
  selection: ICON_SELECTION,
  upload: ICON_UPLOAD,
  package: ICON_PACKAGE,
  agent: ICON_AGENT,
  ask: ICON_ASK,
  shield: ICON_SHIELD,
  gear: ICON_GEAR,
  speed: ICON_SPEED,
  close: ICON_CLOSE,
  search: ICON_SEARCH_SMALL,
  back: ICON_BACK,
  history: ICON_HISTORY_SMALL,
  diff: ICON_DIFF,
  branch: ICON_BRANCH,
  commit: ICON_COMMIT,
  plus: ICON_PLUS,
  info: ICON_INFO,
  repo: ICON_REPO,
} as const;

/* ------------------------------------------------------------------ */
/* Styles                                                              */
/* ------------------------------------------------------------------ */

const STYLES = `
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  display: flex;
  flex-direction: column;
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background);
  font: var(--vscode-font-size)/1.5 var(--vscode-font-family);
  overflow: hidden;
}
/* The document is written once and everything inside #root is replaced on each
   update, so #root has to be the flex column the body used to be — otherwise the
   thread stops growing to fill the panel and the composer floats up under the
   last message instead of sitting at the bottom where it belongs. */
#root {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
a:hover { text-decoration: underline; }
small { color: var(--vscode-descriptionForeground); }
p { margin: 0 0 6px; }
p:last-child { margin-bottom: 0; }
h2 { font-size: 15px; margin: 0 0 6px; }
h4 { font-size: 12px; margin: 0; }
svg.i { vertical-align: -2px; flex: 0 0 auto; }
code {
  font-family: var(--vscode-editor-font-family);
  font-size: .92em;
  /* Explicit rather than left to inherit: a token span from \`highlightCode()\`
     can sit inside this element and set its own colour, but plain, unhighlighted
     code — every inline \`\` \`backtick\` \`\` span in prose — has none, and must
     not end up reading whatever colour happened to cascade in from a container
     that was never meant to set it. */
  color: var(--vscode-foreground);
  background: var(--vscode-textCodeBlock-background);
  border-radius: 3px;
  padding: 1px 4px;
  /* A long declaration quoted inline — a signature, a file path — is exactly
     as wide as the code it quotes, and wrapping it mid-token wrecks the thing
     being shown. \`inline-block\` is what lets a normally-inline element scroll
     its own overflow instead of the wrap a bare \`inline\` box is stuck with;
     \`pre\` stops the browser from collapsing that overflow back down by
     re-wrapping it anyway. */
  display: inline-block;
  max-width: 100%;
  overflow-x: auto;
  vertical-align: bottom;
  white-space: pre;
}
/* Code keeps its own lines and scrolls sideways, the way the editor does.
   Wrapping a declaration mid-signature re-flows it into something that is no
   longer the code being quoted, and a block with no horizontal scroll is
   simply cropped at the panel's edge. */
pre {
  margin: 6px 0;
  padding: 8px;
  overflow-x: auto;
  overflow-y: auto;
  max-width: 100%;
  max-height: 240px;
  white-space: pre;
  word-break: normal;
  line-height: 1.5;
  /* The editor's font *family*, so code reads as code — but the panel's own
     font size, not the editor's. A developer who sets a 16px editor for
     comfortable all-day reading has not asked a side panel's quoted
     declarations to be larger than the prose around them, and inheriting
     the editor font size made the before/after blocks visibly mismatched with
     every other line in the transcript. The .92 factor matches the inline code
     rule above, so a declaration is the same size whether it is quoted in a
     sentence or shown in a block. */
  font-family: var(--vscode-editor-font-family);
  font-size: calc(var(--vscode-font-size, 13px) * .92);
  background: var(--vscode-textCodeBlock-background);
  border-radius: 5px;
}
/* \`pre\` already owns the scrolling and the whitespace for a block of code; the
   \`display\`/\`overflow-x\`/\`white-space\` the bare \`code\` rule above adds for a
   standalone inline span would only fight it here — an \`inline-block\` inside
   an already-scrolling \`pre\` adds baseline spacing at the block's edges that
   reads as a stray gap. */
pre code {
  background: none;
  padding: 0;
  font-size: inherit;
  display: inline;
  overflow-x: visible;
  max-width: none;
  vertical-align: baseline;
}
button {
  font: inherit;
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 5px;
  padding: 4px 10px;
  color: var(--vscode-button-secondaryForeground);
  background: var(--vscode-button-secondaryBackground);
  cursor: pointer;
}
button:hover { background: var(--vscode-button-secondaryHoverBackground); }
button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
button.primary:hover { background: var(--vscode-button-hoverBackground); }
button:disabled { opacity: .45; cursor: default; }
button.wide { width: 100%; }

/* Toolbar controls ------------------------------------------------ */
/* Every picker in the panel is one of these: a flat, theme-coloured
   button that opens a real VS Code quick pick. Fixed height plus
   centred flex is what keeps the label optically centred at any font
   size, which an OS-drawn dropdown in a webview never manages. */
.ctl {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  height: 22px;
  min-width: 0;
  padding: 0 5px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: none;
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
}
.ctl > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ctl svg.i { vertical-align: 0; opacity: .9; }
.ctl:hover {
  color: var(--vscode-foreground);
  background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
}
/* Hover and the open menu already say which control is in play. An outline
   on top of that reads as a validation error on a button that is merely
   focused, so the focused control is shown the same way it is hovered. */
.ctl:focus-visible { outline: none; background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
.menu-item:focus-visible { outline: none; }
.ctl.icon { padding: 0 4px; }
.ctl.bordered {
  border-color: var(--vscode-dropdown-border, var(--vscode-panel-border));
  background: var(--vscode-dropdown-background);
  color: var(--vscode-dropdown-foreground);
  justify-content: space-between;
  padding: 0 4px 0 7px;
}

/* Thread ---------------------------------------------------------- */
.thread {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 12px 12px 6px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.turn { display: flex; flex-direction: column; gap: 5px; }
.who {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .02em;
  color: var(--vscode-descriptionForeground);
}
.turn.user .bubble {
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: 6px;
  padding: 7px 9px;
}
.turn.assistant .body { padding-left: 20px; }
.markdown ul { margin: 4px 0 6px; padding-left: 18px; }
.markdown h4 { margin: 8px 0 4px; }

/* Rewind ---------------------------------------------------------- */
/* Sits in the turn's own header, visible only when the pointer is in the
   turn — always-on undo affordances on every message are visual noise, and
   this one is destructive enough that it should take an intention to find. */
.ctl.rewind { margin-left: auto; height: 18px; font-size: 10px; opacity: 0; transition: opacity .1s; }
.turn.user:hover .ctl.rewind, .ctl.rewind:focus-visible { opacity: 1; }

/* Welcome --------------------------------------------------------- */
.welcome { text-align: center; padding: 22px 6px 6px; }
/* Once there is work underneath it, the introduction stops behaving like a
   splash screen and becomes a header: same words, less room, and a rule
   separating it from the results it is standing above. */
.welcome.compact {
  text-align: left;
  padding: 0 0 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
}
.welcome.compact h2 { font-size: 13px; }
.welcome.compact > p { font-size: 11px; }
.welcome .mark { color: var(--vscode-textLink-foreground); margin-bottom: 8px; }
.welcome > p { color: var(--vscode-descriptionForeground); margin-bottom: 14px; }
.suggestions { display: flex; flex-direction: column; gap: 6px; }
.suggestions button {
  display: flex;
  gap: 9px;
  align-items: flex-start;
  text-align: left;
  padding: 9px 10px;
  background: var(--vscode-editorWidget-background);
  border-color: var(--vscode-panel-border);
}
.suggestions .icon { color: var(--vscode-textLink-foreground); margin-top: 2px; }
.suggestions span span, .suggestions button > span:last-child { display: flex; flex-direction: column; }
.suggestions b { font-weight: 600; }
.suggestions small { line-height: 1.35; }
.welcome .foot { margin-top: 14px; font-size: 11px; color: var(--vscode-descriptionForeground); }
.welcome .foot.warn { color: var(--vscode-editorWarning-foreground); }

/* Notices --------------------------------------------------------- */
.notice {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 8px 10px;
  border-radius: 6px;
  border-left: 2px solid var(--vscode-panel-border);
  background: var(--vscode-editorWidget-background);
}
.notice.warn { border-left-color: var(--vscode-editorWarning-foreground); color: var(--vscode-editorWarning-foreground); }
.notice.error { border-left-color: var(--vscode-editorError-foreground); color: var(--vscode-editorError-foreground); }
.notice.success { border-left-color: var(--vscode-testing-iconPassed); }
.notice.info svg { color: var(--vscode-charts-blue); }

/* Steps ----------------------------------------------------------- */
.step {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  background: var(--vscode-editorWidget-background);
  padding: 9px 10px;
}
/* Nothing in a step may push past the card's border. The title wraps, the
   live phase line ellipsises, and both are constrained by min-width: 0 —
   without it a flex child refuses to shrink below its content and simply
   overflows, which is exactly how "Checking your dependencies" ended up
   sitting on top of the frame. */
.step-head { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
.step-head svg.i, .step-head .spinner { align-self: center; }
.step-head b { min-width: 0; flex: 1 1 auto; overflow-wrap: anywhere; }
.step-head .count { flex: 0 0 auto; font-size: 11px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
.step.done .step-head svg { color: var(--vscode-testing-iconPassed); }
.step.failed .step-head svg { color: var(--vscode-editorError-foreground); }
.step-now {
  display: flex;
  gap: 6px;
  margin: 4px 0 0 21px;
  font-size: 11px;
  min-width: 0;
}
.step-now .phase { color: var(--vscode-foreground); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.step-now .detail {
  color: var(--vscode-descriptionForeground);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.step .bar {
  height: 2px;
  margin: 8px 0 0 21px;
  border-radius: 2px;
  background: var(--vscode-panel-border);
  overflow: hidden;
}
.step .bar span {
  display: block;
  height: 100%;
  background: var(--vscode-progressBar-background);
  transition: width .2s linear;
}
.step .log { margin: 7px 0 0 21px; font-size: 11px; }
.step .log summary { cursor: pointer; color: var(--vscode-descriptionForeground); }
.step .log ol {
  margin: 5px 0 0;
  padding-left: 28px;
  max-height: 170px;
  overflow: auto;
  color: var(--vscode-descriptionForeground);
}
/* A path in a progress line is a link, but it must not look like prose with a
   colour dropped on it — the code face is what says "this is a file". */
.step .log a code, .step-now a code { background: none; padding: 0; font-size: inherit; }
/* A step that ran a command is the control for showing what it printed. It
   reads as an ordinary log line until it is hovered — the list is something
   to read first and something to click second, and turning every line into a
   button-shaped thing would cost the reading.
   Inline, and only around the phase: the list is numbered, and that numbering
   is its reading order, so every line keeps its marker — and the detail after
   the phase keeps its own file links instead of being swallowed by the
   button. */
.step .log .log-line {
  font: inherit;
  color: inherit;
  background: none;
  border: none;
  border-radius: 3px;
  padding: 0 3px;
  margin: 0 0 0 -3px;
  text-align: left;
  cursor: pointer;
  text-decoration: underline;
  text-decoration-style: dotted;
  text-underline-offset: 2px;
  text-decoration-color: var(--vscode-descriptionForeground);
}
.step .log .log-line:hover {
  background: var(--vscode-list-hoverBackground);
  color: var(--vscode-foreground);
  text-decoration-color: var(--vscode-foreground);
}
.step .log .log-line.active {
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
  text-decoration: none;
}

/* The running command's own output. Bounded and scrolled: this is a live
   window onto a process, not its transcript. Every phase's segment stays in
   the DOM at once; which one is visible is a client-side toggle (see
   \`selectOutput\` in the page script) rather than anything re-rendered from
   the host, so switching tabs is instant and never waits on a message
   round trip. */
.step-output { margin: 7px 0 0 21px; font-size: 11px; }
.output-tabs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin-bottom: 4px;
}
/* Which phase's output is on screen, spelled out in full. The row has one
   control on it now, so the name has all the room the tabs never did. */
.output-phase {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  padding: 2px 0;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.output-phase.pinned { color: var(--vscode-foreground); font-weight: 600; }
.output-tab {
  font: inherit;
  font-size: 10px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 10px;
  padding: 2px 8px;
  background: transparent;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.output-tab:hover { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); }
/* The active tab reads as pressed, not just differently coloured — a single
   colour shift is easy to miss at 10px next to five other pills the same
   shape. */
.output-tab.active {
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border-color: transparent;
  font-weight: 600;
}
.output-tab.live::before {
  content: '';
  display: inline-block;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--vscode-testing-iconPassed, #2ea043);
  margin-right: 4px;
  vertical-align: middle;
}
.step-output pre {
  margin: 0;
  max-height: 150px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}
.step-output pre[hidden] { display: none; }
/* A soft fading ring rather than a hard two-tone border — the border trick
   reads as two flat arcs (one grey, one accent) chasing each other, which at
   a glance looks like a stray line spinning rather than a loading indicator.
   A conic gradient masked down to a ring fades smoothly around its own
   circumference instead, the same shape VS Code's own spinners use. */
.spinner {
  width: 13px;
  height: 13px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: conic-gradient(from 0turn, transparent, transparent 65%, var(--vscode-progressBar-background));
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 1.6px), #000 calc(100% - 1.6px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 1.6px), #000 calc(100% - 1.6px));
  animation: spin .8s linear infinite;
}
@keyframes spin { to { transform: rotate(1turn); } }

/* Clicked button gets the spinner immediately, before the extension has had
   a chance to answer — a click that visibly did nothing is what makes people
   click twice and fire the same action again. */
/* The label stays, and the spinner sits after it.
   Blanking the text to centre a spinner in the gap costs the one thing a
   developer needs while they wait: which button they pressed. "Upgrade and fix
   3 sites" and "Create issue" sit next to each other, and an empty blue
   rectangle is not an answer to "what did I just start?". */
button[data-action].is-loading {
  position: relative;
  pointer-events: none;
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
button[data-action].is-loading::after {
  content: '';
  flex: 0 0 auto;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  /* Drawn in the button's own foreground colour, not the progress bar's.
     A primary button is painted in VS Code's button background — its blue —
     and the progress-bar colour is the same blue, so the spinner was a blue ring
     on a blue field: present, animating, and effectively invisible. The
     foreground colour is the one colour every theme guarantees is readable
     against this exact background, because it is what the label is drawn in.
     The faint remainder of the ring keeps the moving end legible instead of
     leaving a lone arc chasing nothing. */
  background: conic-gradient(from 0turn, currentColor 0deg, transparent 60deg, transparent 330deg, currentColor);
  opacity: .9;
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 1.6px), #000 calc(100% - 1.6px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 1.6px), #000 calc(100% - 1.6px));
  animation: spin .8s linear infinite;
}
/* An icon-only button has no label to sit beside, so its spinner takes the
   icon's place rather than being added next to it. */
button[data-action].ctl.icon.is-loading > svg { display: none; }
button.stop.is-loading {
  justify-content: center;
  gap: 0;
}
button.stop.is-loading > svg { display: none; }
button.stop.is-loading::after {
  margin: 0;
}
button[data-action]:disabled:not(.is-loading) { opacity: .55; cursor: default; }

/* Questions ------------------------------------------------------- */
.question.open { border-left: 2px solid var(--vscode-focusBorder); padding-left: 8px; }
.options { display: flex; flex-direction: column; gap: 5px; margin: 8px 0 0 20px; }
.options button { text-align: left; display: flex; flex-direction: column; gap: 1px; }
.answered-with {
  display: flex;
  gap: 6px;
  align-items: center;
  margin: 6px 0 0 20px;
  font-size: 11px;
  color: var(--vscode-testing-iconPassed);
}
.hint { font-size: 11px; color: var(--vscode-descriptionForeground); }

/* Package results ------------------------------------------------- */
/* One card. The frame belongs to the card, the separators to the rows;
   nothing inside draws a box of its own, which is what stops a long scan
   from reading as a pile of unrelated widgets. */
.card {
  margin-top: 8px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  background: var(--vscode-editorWidget-background);
  overflow: hidden;
}
.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  background: var(--vscode-editorWidget-background);
  border-bottom: 1px solid var(--vscode-panel-border);
}
.card-title { display: flex; align-items: center; gap: 6px; font-size: 11px; }
.card-title svg.i { color: var(--vscode-descriptionForeground); }
.tallies { display: flex; align-items: center; gap: 10px; margin-left: auto; font-size: 10px; }
.tally { color: var(--vscode-descriptionForeground); white-space: nowrap; }
.tally b { font-variant-numeric: tabular-nums; }
.tally.affected b { color: var(--vscode-editorWarning-foreground); }
.tally.clean b { color: var(--vscode-testing-iconPassed); }
.tally.error b { color: var(--vscode-editorError-foreground); }
.tally.unchecked b { color: var(--vscode-editorWarning-foreground); }
.card-head .ctl.icon { margin-left: 4px; flex: 0 0 auto; }

/* Something changed under the results ----------------------------- */
.stale {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 10px;
  font-size: 11px;
  border-bottom: 1px solid var(--vscode-panel-border);
  background: var(--vscode-inputValidation-infoBackground, var(--vscode-editorWidget-background));
  color: var(--vscode-foreground);
}
.stale > span { flex: 1; min-width: 0; }
.stale button { padding: 1px 8px; font-size: 11px; flex: 0 0 auto; }
.pkg-group + .pkg-group { border-top: 1px solid var(--vscode-panel-border); }
.pkg-group > summary { cursor: pointer; list-style: none; }
.pkg-group > summary::-webkit-details-marker { display: none; }
.pkg-group[open] > summary .i-chevron { transform: rotate(90deg); }
.pkg-subhead {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  color: var(--vscode-descriptionForeground);
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: .04em;
}
.pkg-group > summary:hover .pkg-subhead { background: var(--vscode-list-hoverBackground); }
.pkg-subhead span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.pkg-subhead small { text-transform: none; letter-spacing: 0; font-variant-numeric: tabular-nums; }
.pkg-subhead.affected > svg.i:last-of-type { color: var(--vscode-editorWarning-foreground); }
.pkg-subhead.clean > svg.i:last-of-type { color: var(--vscode-testing-iconPassed); }
.pkg-subhead.error > svg.i:last-of-type { color: var(--vscode-editorError-foreground); }
/* Unverified is not an error and not a pass. It borrows the warning colour but
   never the alarm styling: the developer has a decision to make, not a failure
   to clean up. */
.pkg-subhead.unchecked > svg.i:last-of-type { color: var(--vscode-editorWarning-foreground); }
/* "Upgrade all" and "Create N issues" sit side by side, sharing the row
   evenly, rather than each claiming the full width and stacking — a group
   of packages usually offers both, and stacked full-width buttons buried
   the second, lower-priority one below the fold. */
.pkg-group-foot { display: flex; gap: 6px; padding: 2px 10px 9px; }
.pkg-group-foot button.wide { width: auto; flex: 1 1 0; }
.pkg { border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 55%, transparent); }
.pkg > summary {
  display: grid;
  grid-template-columns: auto minmax(min(15ch, 100%), 1fr) minmax(0, clamp(88px, 36%, 170px));
  gap: 8px;
  align-items: center;
  padding: 7px 10px;
  cursor: pointer;
  list-style: none;
}
.pkg > summary:hover { background: var(--vscode-list-hoverBackground); }
.pkg[open] > summary { background: var(--vscode-list-inactiveSelectionBackground, var(--vscode-list-hoverBackground)); }
.pkg > summary::-webkit-details-marker { display: none; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--vscode-testing-iconPassed); }
.dot.affected { background: var(--vscode-editorWarning-foreground); }
.dot.error, .dot.verification-failed { background: var(--vscode-editorError-foreground); }
.dot.unchecked { background: var(--vscode-descriptionForeground); }
.dot.pending { background: var(--vscode-descriptionForeground); opacity: .5; }
.pkg-name { min-width: 0; display: flex; flex-direction: column; }
.pkg-name b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pkg-workspace {
  align-self: flex-start; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 0.85em; opacity: 0.7; padding: 0 4px; border-radius: 3px;
  border: 1px solid var(--vscode-panel-border); margin: 1px 0;
}
/* The repository a row came from outranks which package within it — shown
   first, and a shade more visible, so two tags on one row still read as a
   hierarchy rather than a pair of unrelated labels. */
.pkg-repo { opacity: 0.85; border-color: var(--vscode-focusBorder); }
/* The registry a package came from, shown on every row: one scan can span
   several ecosystems at once, and the name alone does not say which. */
.pkg-ecosystem {
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 0.85em; opacity: 0.8; padding: 0 4px; border-radius: 3px; margin: 1px 0;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  text-transform: lowercase;
}
.pkg-tags { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; align-self: flex-start; max-width: 100%; }
.versions { font-size: 11px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
.versions .arrow { opacity: .6; }
.verdict {
  min-width: 0;
  max-width: 100%;
  justify-self: end;
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border-radius: 3px;
  padding: 1px 6px;
  color: var(--vscode-descriptionForeground);
  border: 1px solid var(--vscode-panel-border);
}
.verdict.affected {
  color: var(--vscode-editorWarning-foreground);
  border-color: var(--vscode-editorWarning-foreground);
}
.verdict.clean, .verdict.upstream-only { color: var(--vscode-testing-iconPassed); border-color: transparent; }
.verdict.unchecked {
  color: var(--vscode-editorWarning-foreground);
  border-color: var(--vscode-editorWarning-foreground);
}
/* A row that is still working says what it is working on, so it is the one
   verdict allowed to be long — it wraps rather than being clipped to a width
   that would turn a named build command into an ellipsis. The spinner in front
   of it is what marks it as an activity rather than a result.
   Marked with a class the renderer sets rather than matched with :has() on the
   spinner: the two say the same thing, but one of them depends on a selector
   whose support varies with whichever Chromium the running VS Code was built
   against, and silently does nothing where it is missing. */
.verdict.pending, .verdict.busy {
  color: var(--vscode-descriptionForeground);
  border-color: transparent;
  white-space: normal;
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 5px;
  text-align: right;
  overflow-wrap: anywhere;
}
/* Why a check came up short, under the verdict it explains. */
/* The upgrade rationale. Tinted by tone, and only where there is a tone to
   carry: "neutral" borrows the panel's ordinary border rather than a colour, so
   colour keeps meaning something. */
.rationale { margin: 0 0 8px; padding: 6px 8px; border-left: 2px solid var(--vscode-panel-border); border-radius: 2px; background: var(--vscode-textBlockQuote-background); }
.rationale.good { border-left-color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
.rationale.bad { border-left-color: var(--vscode-editorWarning-foreground); }
.rationale-heading { display: block; font-size: 11px; font-weight: 600; margin-bottom: 3px; }
.rationale ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.rationale li { font-size: 11px; color: var(--vscode-descriptionForeground); }
.fact-more > summary { cursor: pointer; width: fit-content; }
.fact-more > ul { margin-top: 2px; padding-left: 8px; }

.verification { display: flex; gap: 6px; align-items: flex-start; margin: 0 0 8px; font-size: 11px; line-height: 1.45; }
.verification svg.i { flex: none; margin-top: 2px; }
.verification code { font-size: 10px; opacity: 0.85; }
.verification.passed { color: var(--vscode-descriptionForeground); }
.verification.failed { color: var(--vscode-editorError-foreground); }
.verification.failed svg.i { color: var(--vscode-editorError-foreground); }
.verification.skipped, .verification.pending { color: var(--vscode-descriptionForeground); }
.verification.skipped svg.i, .verification.pending svg.i { color: var(--vscode-editorWarning-foreground); }
.gaps { list-style: none; margin: 0 0 8px; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.gaps li { display: flex; gap: 6px; align-items: flex-start; font-size: 11px; color: var(--vscode-descriptionForeground); }
.gaps svg.i { flex: none; margin-top: 2px; color: var(--vscode-editorWarning-foreground); }
.tool-requests { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: -2px 0 8px 20px; }
.tool-requests span { flex: 1 1 190px; min-width: 0; font-size: 11px; color: var(--vscode-descriptionForeground); }
/* A one-click major is still one click, but it should not look like the safe
   one sitting next to it. */
.pkg-actions button.risky { border-color: var(--vscode-editorWarning-foreground); }
.pkg-body { padding: 2px 10px 10px 25px; }
.verdict-long { margin: 6px 0 8px; color: var(--vscode-descriptionForeground); }
.pkg-target { display: flex; gap: 7px; align-items: center; margin-bottom: 8px; }
.pkg-target .field-label { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
.pkg-target .ctl { flex: 0 1 auto; max-width: 190px; }
.pkg-target .kind { margin-left: auto; font-size: 10px; color: var(--vscode-descriptionForeground); }
/* After the kind, at the far end of the row: an affordance, not a call to action. */
.pkg-target .pkg-recheck { flex: 0 0 auto; margin-left: 0; opacity: 0.75; }
.pkg-target .pkg-recheck:hover { opacity: 1; }
.pkg-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.pkg-actions button {
  flex: 1 1 auto;
  min-height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  white-space: nowrap;
}
.detail { display: flex; flex-direction: column; gap: 6px; margin-bottom: 9px; }
.break, .sub {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 5px;
  overflow: hidden;
}
.break > summary, .sub > summary {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 6px 8px;
  cursor: pointer;
  font-size: 12px;
}
.sub > summary { color: var(--vscode-descriptionForeground); }
.break-summary { min-width: 0; overflow-wrap: anywhere; }
.confidence {
  font-size: 9px;
  text-transform: uppercase;
  border-radius: 3px;
  padding: 1px 5px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
}
.confidence.high { background: var(--vscode-editorWarning-foreground); color: var(--vscode-editor-background); }
.break-body, .sub > :not(summary) { padding: 0 8px 8px; }
.sub > p { padding-top: 6px; }
.symbols { display: flex; flex-wrap: wrap; gap: 4px; }
.fix { margin: 6px 0; }
.fix .markdown, .fix p { display: inline; }
.fix .code-compare { display: block; }
ul.sites { margin: 6px 0; padding: 0; list-style: none; display: grid; gap: 5px; }
ul.sites li { display: grid; gap: 1px; min-width: 0; }
ul.sites code.excerpt { font-size: 11px; color: var(--vscode-descriptionForeground); background: none; padding: 0;
                        white-space: pre; overflow-x: auto; min-width: 0; }

/* A before/after pair is one block, full width, with its action in a header
   row above it — never beside the code itself, which would squeeze both
   declarations into whatever width the button left over. The button sits
   right next to the "before / after" label rather than pushed to the row's
   far edge: a right-aligned button in a narrow sidebar (the normal width for
   this panel) runs out of room and clips, which reads as the action having
   vanished rather than just being laid out awkwardly. */
.compare { margin: 8px 0; min-width: 0; }
.compare-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; flex-wrap: wrap; }
.compare-label { font-size: 9px; letter-spacing: .04em; text-transform: uppercase;
                 color: var(--vscode-descriptionForeground); }
.evidence { display: grid; gap: 5px; margin-top: 6px; }
.evidence > details { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 5px 7px; }
.evidence summary { display: flex; gap: 6px; align-items: center; cursor: pointer; overflow-wrap: anywhere; }
.source {
  font-size: 9px;
  text-transform: uppercase;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border-radius: 3px;
  padding: 1px 5px;
  white-space: nowrap;
}
.quote { max-height: 200px; overflow: auto; margin-top: 5px; font-size: 11px; }
.code-compare { margin: 6px 0; }
.code-compare figcaption {
  color: var(--vscode-descriptionForeground);
  font-size: 9px;
  letter-spacing: .04em;
  margin-bottom: 3px;
  text-transform: uppercase;
}
/* The one place code wraps instead of scrolling.
   A before/after pair is a *declaration*, normalised onto a single line, and
   the whole point of showing both is to compare their ends — which is where a
   parameter gets added and where a return type changes. In a sidebar a few
   hundred pixels wide, a line that scrolls sideways hides exactly the part the
   pair exists to show, and the reader has to drag two blocks independently to
   the same offset to compare them. Wrapping keeps both ends on screen and both
   sides aligned; newlines are still honoured, so a genuinely multi-line
   snippet keeps its shape. */
.code-compare pre {
  margin-top: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: none;
}

/* Changes --------------------------------------------------------- */
.changes {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  background: var(--vscode-editorWidget-background);
  padding: 9px 10px;
}
.changes-head { display: flex; gap: 8px; align-items: flex-start; justify-content: space-between; }
.changes-head small { display: block; font-size: 11px; }
.changes-actions { display: flex; gap: 5px; flex: 0 0 auto; }
.changes > .hint { margin: 6px 0 8px; }
.add { color: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-testing-iconPassed)); }
.del { color: var(--vscode-gitDecoration-deletedResourceForeground, var(--vscode-editorError-foreground)); }
.change-group { border-top: 1px solid var(--vscode-panel-border); padding-top: 8px; margin-top: 8px; }
.change-group.committed { opacity: .7; }
.change-group.commit-error { border-top-color: var(--vscode-editorError-foreground); }
.hint.error { color: var(--vscode-editorError-foreground); }
.group-head { display: flex; gap: 7px; align-items: center; }
.group-head > div:not(.group-actions) { min-width: 0; flex: 1; }
.group-head b { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.group-head small { font-size: 10px; }
.group-actions { display: flex; gap: 5px; flex: 0 0 auto; }
.change-file {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 4px 8px;
  align-items: center;
  padding: 6px 0 6px 21px;
  border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 60%, transparent);
}
.change-file .path { display: flex; gap: 6px; align-items: center; min-width: 0; }
.change-file .path span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.change-file .stat { font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.change-file .hunks { display: none; }
.change-file .file-actions { grid-column: 2; display: flex; gap: 5px; }
.change-file .file-actions button { padding: 2px 8px; font-size: 11px; }

/* Composer -------------------------------------------------------- */
.composer {
  position: relative;
  flex: 0 0 auto;
  margin: 6px 10px 10px;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: 6px;
  background: var(--vscode-input-background);
  padding: 6px 6px 5px;
}
.composer:focus-within { border-color: var(--vscode-focusBorder); }
.composer.answering { border-color: var(--vscode-focusBorder); }
.chips { display: flex; flex-wrap: wrap; gap: 4px; margin: 0 2px 5px; }
.chips.small { margin: 0; }
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 19px;
  font-size: 11px;
  line-height: 1;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  padding: 0 3px 0 6px;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-badge-background);
  max-width: 100%;
}
.chips.small .chip { background: none; }
.chip svg.i { vertical-align: 0; opacity: .8; }
.chip-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; }
.chip button {
  display: inline-grid;
  place-items: center;
  width: 15px;
  height: 15px;
  border: 0;
  border-radius: 3px;
  background: none;
  padding: 0;
  color: inherit;
}
.chip button:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
#input {
  font: inherit;
  display: block;
  width: 100%;
  min-height: 22px;
  max-height: 160px;
  resize: none;
  border: 0;
  outline: none;
  padding: 3px 2px 5px;
  color: var(--vscode-input-foreground);
  background: transparent;
}
/* One row, always. A control row that wraps changes the composer's height as
   labels change, which moves the send button under the developer's pointer. */
.composer-bar { display: flex; align-items: center; gap: 2px; flex-wrap: nowrap; min-width: 0; }
.composer-bar .spacer { flex: 1 1 auto; min-width: 8px; }
/* Four controls and a send button in a sidebar that can be 200px wide: the
   labelled ones give up their text before anything wraps or overflows, and the
   icon still says which control it is. Send never shrinks. */
.composer-bar .ctl { flex: 0 1 auto; }
.composer-bar .ctl.icon, .composer-bar button.send, .composer-bar button.stop { flex: 0 0 auto; }
button.send, button.stop {
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  display: inline-grid;
  place-items: center;
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
}
button.send:hover { background: var(--vscode-button-hoverBackground); }
button.send svg.i, button.stop svg.i { vertical-align: 0; }
button.stop { background: var(--vscode-editorError-foreground); color: var(--vscode-editor-background); }
button.stop.stopping {
  display: inline-grid;
  place-items: center;
}
button.stop.stopping .spinner {
  background: conic-gradient(from 0turn, transparent, transparent 65%, currentColor);
}
.commands {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 210px;
  overflow: auto;
  margin-bottom: 6px;
  border-bottom: 1px solid var(--vscode-panel-border);
  padding-bottom: 6px;
}
.commands[hidden] { display: none; }
/* One command, one line. The name and what it does belong on the same row —
   stacked, ten commands became a wall the eye has to climb, and the list is
   read by scanning names down the left edge. Anything that does not fit is
   ellipsised rather than allowed to wrap. */
button.command {
  border: 0;
  background: none;
  text-align: left;
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 3px 6px;
  border-radius: 4px;
  white-space: nowrap;
  /* Not overflow: hidden here — each child already clips its own text (the
     row itself is nowrap, and the description has its own ellipsis).
     overflow: hidden on this flex row, combined with baseline alignment and
     children of different font sizes, made Chromium compute an auto height
     shorter than either child's own line height — every row rendered a
     couple of pixels tall with the text clipped off top and bottom,
     unreadable regardless of panel width. */
}
button.command[hidden] { display: none; }
button.command:hover, button.command.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
button.command b { flex: 0 0 auto; font-weight: 500; }
button.command .args { color: var(--vscode-descriptionForeground); font-weight: 400; }
button.command small { flex: 1 1 auto; min-width: 0; font-size: 10px; overflow: hidden; text-overflow: ellipsis; }
button.command:hover small, button.command.active small { color: inherit; opacity: .8; }

/* Working, uninterruptibly ---------------------------------------- */
.working {
  width: 22px;
  height: 22px;
  display: inline-grid;
  place-items: center;
}

/* The composer menu ------------------------------------------------ */
/* Drawn in the panel, anchored to whichever control opened it, and styled
   from the editor's own menu tokens so it is the widget VS Code would have
   drawn. It opens upward because the composer is at the bottom of a narrow
   sidebar; there is never room below. */
.menu {
  position: absolute;
  bottom: calc(100% - 4px);
  left: 4px;
  z-index: 20;
  /* One width for every section. A menu that resized itself as the developer
     drilled from the subscriptions into a model list jumped under the pointer
     each time, which made the drill-in feel like a different widget opening. */
  width: min(288px, calc(100vw - 28px));
  display: flex;
  flex-direction: column;
  border: 1px solid var(--vscode-menu-border, var(--vscode-editorWidget-border, var(--vscode-panel-border)));
  border-radius: 6px;
  background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
  box-shadow: 0 4px 14px var(--vscode-widget-shadow, rgba(0, 0, 0, .36));
  overflow: hidden;
}
.menu[hidden] { display: none; }
.menu-search {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--vscode-menu-separatorBackground, var(--vscode-panel-border));
}
.menu-search svg.i { color: var(--vscode-descriptionForeground); }
#menu-filter {
  font: inherit;
  flex: 1;
  min-width: 0;
  border: 0;
  outline: none;
  padding: 0;
  color: var(--vscode-input-foreground);
  background: transparent;
}
.menu-list { overflow-y: auto; max-height: min(330px, 55vh); padding: 4px; }
.menu-section[hidden] { display: none; }
.menu-title {
  padding: 5px 6px 3px;
  font-size: 10px;
  letter-spacing: .05em;
  text-transform: uppercase;
  color: var(--vscode-descriptionForeground);
}
.menu-section + .menu-section .menu-title {
  margin-top: 3px;
  border-top: 1px solid var(--vscode-menu-separatorBackground, var(--vscode-panel-border));
  padding-top: 7px;
}
.menu-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  border: 0;
  border-radius: 4px;
  padding: 4px 6px;
  background: none;
  color: var(--vscode-menu-foreground, var(--vscode-foreground));
  text-align: left;
}
.menu-item[hidden] { display: none; }
.menu-item:hover, .menu-item.active {
  background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground));
  color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground));
}
.menu-check { width: 13px; flex: 0 0 auto; display: inline-grid; place-items: center; }
.menu-check svg.i { color: var(--vscode-menu-selectionForeground, var(--vscode-foreground)); }
.menu-icon { display: inline-grid; place-items: center; flex: 0 0 auto; opacity: .85; }
.menu-icon:empty { display: none; }
.menu-text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.menu-text b { font-weight: 400; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.menu-text small { font-size: 10px; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.menu-item:hover .menu-text small, .menu-item.active .menu-text small { color: inherit; opacity: .8; }
.menu-more { flex: 0 0 auto; display: inline-grid; place-items: center; opacity: .7; }
.menu-hint {
  flex: 0 0 auto;
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.menu-item:hover .menu-hint, .menu-item.active .menu-hint { color: inherit; opacity: .8; }
.menu-empty { padding: 8px 10px; font-size: 11px; color: var(--vscode-descriptionForeground); }
.menu-empty[hidden] { display: none; }

/* The effort dial -------------------------------------------------- */
/* Fixed height, deliberately. The dial's explanation changes with every
   position, and a menu that resized itself around the current sentence
   moved the handle out from under the pointer mid-drag. The explanation is
   given the height of the longest stop, so nothing moves as it is dragged. */
.slider {
  /* Fills the menu, which sets its own width. The label positions are a
     fraction of whatever that turns out to be, so nothing here depends on a
     hard-coded number. */
  padding: 4px 8px 2px;
  /* The two numbers the label placement is derived from. The handle is drawn
     here rather than left to the platform precisely so that its size is known:
     a label can only be centred under a circle whose width is not a guess. */
  --thumb: 12px;
  /* How far the track is held back from the edges. Enough that the outermost
     labels can sit centred on their handles without leaving the menu. */
  --inset: 24px;
}
.slider input[type="range"] {
  -webkit-appearance: none;
  appearance: none;
  display: block;
  width: calc(100% - 2 * var(--inset));
  margin: 4px var(--inset) 2px;
  height: var(--thumb);
  background: transparent;
  cursor: pointer;
}
.slider input[type="range"]::-webkit-slider-runnable-track {
  height: 3px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--vscode-foreground) 26%, transparent);
}
.slider input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: var(--thumb);
  height: var(--thumb);
  border-radius: 50%;
  border: none;
  background: var(--vscode-button-background, var(--vscode-progressBar-background));
  /* Centres the circle on a 3px track. */
  margin-top: calc((3px - var(--thumb)) / 2);
}
/* The editor draws a focus ring around a range input the moment it is
   touched, which reads as an error state on a control that is working
   exactly as intended. */
.slider input[type="range"]:focus,
.slider input[type="range"]:focus-visible { outline: none; }
/* Each label is absolutely placed at its own handle's centre — see
   stopCentre() — and pulled back by half its width, so it reads as belonging
   to that circle rather than to the gap beside it. */
.slider-ticks {
  position: relative;
  height: 14px;
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
}
.slider-ticks span {
  position: absolute;
  top: 0;
  transform: translateX(-50%);
  white-space: nowrap;
  line-height: 14px;
}
.slider-ticks span.on { color: var(--vscode-foreground); font-weight: 600; }
.slider-detail {
  margin: 4px 0 2px;
  font-size: 10px;
  line-height: 1.35;
  /* Two lines, always: the height of the longest stop's explanation. */
  height: 2.7em;
  overflow: hidden;
  color: var(--vscode-descriptionForeground);
}

/* The plan, as a checklist ---------------------------------------- */
.card.tasks .card-title b { font-weight: 600; }
.tasks-sub {
  margin: 0;
  padding: 6px 10px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 55%, transparent);
}
.task-group + .task-group { border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 55%, transparent); }
.task-group > summary {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 10px;
  cursor: pointer;
  list-style: none;
}
.task-group > summary::-webkit-details-marker { display: none; }
.task-group > summary:hover { background: var(--vscode-list-hoverBackground); }
.task-group.active > summary { background: var(--vscode-list-inactiveSelectionBackground, var(--vscode-list-hoverBackground)); }
.task-order {
  flex: 0 0 auto;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--vscode-descriptionForeground);
}
.task-title { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.task-title b { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-note { font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-pkg {
  flex: 0 0 auto;
  font-size: 9px;
  border-radius: 3px;
  padding: 1px 5px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  max-width: 30%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-state { flex: 0 0 auto; font-size: 10px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
.task-state.done { color: var(--vscode-testing-iconPassed); }
.task-state.failed { color: var(--vscode-editorError-foreground); }
/* The box: empty until the work is done, so a glance down the left edge
   is a progress bar you can read. */
.box {
  width: 12px;
  height: 12px;
  flex: 0 0 auto;
  display: inline-grid;
  place-items: center;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 3px;
  color: var(--vscode-editor-background);
}
.box.done { background: var(--vscode-testing-iconPassed); border-color: transparent; }
.box.failed { background: var(--vscode-editorError-foreground); border-color: transparent; }
.box.skipped { color: var(--vscode-descriptionForeground); }
.box svg.i { width: 9px; height: 9px; }
ul.task-list { margin: 0; padding: 0 10px 8px 28px; list-style: none; display: grid; gap: 5px; }
li.task { display: flex; gap: 7px; align-items: flex-start; font-size: 11px; }
li.task .box, li.task .spinner { margin-top: 3px; }
li.task.unchanged .task-label, li.task.skipped .task-label { color: var(--vscode-descriptionForeground); }
.task-body { display: flex; flex-direction: column; min-width: 0; gap: 1px; }
.task-label { overflow-wrap: anywhere; }
.task-detail { color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The agent's verdict on this commit unit, in its own words. Set against the
   left rule the activity drawer uses, so it reads as belonging to the group
   above it rather than to the transcript. */
.task-reason {
  margin: 0 10px 8px 28px;
  padding: 6px 0 2px 9px;
  border-left: 1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}
.task-reason.failed { color: var(--vscode-errorForeground); }
.task-reason > :first-child { margin-top: 0; }
.task-reason > :last-child { margin-bottom: 0; }
.activity {
  margin: 0 10px 10px 28px;
  border-left: 1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
}
.activity > summary {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: -1px;
  padding: 3px 0 3px 9px;
  list-style: none;
  cursor: pointer;
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
}
.activity > summary::-webkit-details-marker { display: none; }
.activity > summary:hover { color: var(--vscode-foreground); }
.activity > summary span { font-weight: 500; }
/* Next steps, under the message that proposed them. Sized and spaced like the
   question options above them, because they are the same kind of thing: a
   decision the panel is offering rather than a control that lives in the
   chrome. */
.msg-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 8px 0 2px 0;
}
.msg-actions button {
  padding: 4px 11px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 5px;
  background: var(--vscode-editorWidget-background);
  color: var(--vscode-foreground);
  font-size: 11px;
  cursor: pointer;
}
.msg-actions button:hover {
  background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
  border-color: var(--vscode-focusBorder);
}
.msg-actions button.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border-color: transparent;
}
.msg-actions button.primary:hover { background: var(--vscode-button-hoverBackground); }

/* The agent's running commentary.
   Capped and scrolled rather than left to grow. A long migration produces
   dozens of these, and an unbounded drawer pushes the commit it belongs to —
   and every commit after it — off the bottom of the panel, so the checklist
   that is the point of this view stops being readable exactly when there is
   most to read. Contained overscroll keeps a scroll that reaches the end of
   the drawer from continuing into the transcript underneath. */
.activity-list {
  display: grid;
  gap: 9px;
  padding: 4px 6px 2px 0;
  max-height: 280px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}
.activity-list::-webkit-scrollbar { width: 8px; }
.activity-list::-webkit-scrollbar-thumb {
  background: var(--vscode-scrollbarSlider-background);
  border-radius: 4px;
}
.activity-list::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }
.activity-item {
  position: relative;
  display: grid;
  grid-template-columns: 12px minmax(0, 1fr);
  gap: 7px;
}
.activity-dot {
  width: 7px;
  height: 7px;
  margin: 7px 0 0 -4px;
  border-radius: 50%;
  background: var(--vscode-descriptionForeground);
  box-shadow: 0 0 0 2px var(--vscode-editorWidget-background);
}
.activity-item.edit .activity-dot { background: var(--vscode-testing-iconPassed); }
.activity-item.bash .activity-dot { background: var(--vscode-charts-blue); }
/* A file that did not exist before this run is the one row worth spotting from
   across the drawer, so it gets the added-resource colour git itself uses. */
.activity-item.create .activity-dot { background: var(--vscode-gitDecoration-addedResourceForeground, #2ea043); }
.activity-item.read .activity-dot { background: var(--vscode-charts-yellow, #cca700); }
.activity-body { min-width: 0; display: grid; gap: 4px; }
.activity-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  font-size: 11px;
}
.activity-head b { font-weight: 600; }
.activity-head > span:not(.activity-stat) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.activity-head a { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.activity-stat { margin-left: auto; font-size: 10px; font-variant-numeric: tabular-nums; white-space: nowrap; }
/* One line of reasoning. Capped at roughly six lines and scrolled, so a model
   that thinks in paragraphs cannot push the rest of its own work off screen. */
.activity-detail {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  overflow-wrap: anywhere;
  max-height: 96px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}
.activity-item.search .activity-dot { background: var(--vscode-charts-purple, #b180d7); }
.activity-links { display: flex; flex-wrap: wrap; gap: 4px 6px; }
.activity-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 1px 6px 1px 4px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 10px;
  font-size: 10px;
  cursor: pointer;
}
.activity-link span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.activity-link:hover {
  background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
  text-decoration: none;
}
.activity-link svg.i { flex: 0 0 auto; opacity: .8; }
.activity-io,
.activity-code,
.activity-diff {
  margin: 0;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 5px;
  max-height: 190px;
  font-size: 11px;
}
.activity-io {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  padding: 0;
}
/* An unlabelled snippet gets the full width. It shares everything else with
   .activity-io above and nothing about its column layout, which is the whole
   distinction: reusing that rule put the code itself in the 34px label gutter,
   so every snippet wrapped at about three characters. */
.activity-code {
  padding: 5px 7px;
  overflow: auto;
}
.activity-io span {
  padding: 5px 7px;
  color: var(--vscode-descriptionForeground);
  border-right: 1px solid var(--vscode-panel-border);
}
.activity-io code {
  display: block;
  padding: 5px 7px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.activity-code code {
  display: block;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.activity-diff { display: grid; padding: 5px 0; }
.activity-diff span {
  display: block;
  padding: 0 7px;
  white-space: pre;
}
.activity-diff .add { background: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #2ea043) 24%, transparent); }
.activity-diff .del { background: color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground, #f85149) 20%, transparent); }
.activity-diff .context { color: var(--vscode-descriptionForeground); }
`;

/* ------------------------------------------------------------------ */
/* Webview script                                                      */
/* ------------------------------------------------------------------ */

const SCRIPT = `
const vscode = acquireVsCodeApi();
const root = document.getElementById('root');

/* The panel is re-rendered constantly — a scan reports progress many times a
   second — and everything the developer is in the middle of has to survive
   that: the half-typed message, the caret inside it, the scroll position, the
   disclosure they just opened, the menu they have open right now.

   The document itself is written once. Updates arrive as a body string and are
   swapped into #root, which keeps this script, its listeners and the webview's
   own state alive. Reassigning webview.html instead tears the document down and
   re-runs everything, and on a panel holding a full scan that is the difference
   between a click landing instantly and a click landing a second later. */

const ui = {
  draft: '',
  draftToken: -1,
  caret: null,
  focused: false,
  scrollTop: 0,
  atBottom: true,
  disclosures: {},
  /* Per-drawer scroll, keyed by \`data-scroll\`. */
  scrolls: {},
  /* Which output segment a step's terminal is showing, keyed by step id.
     Missing (or 'live') means "follow whichever phase is newest". */
  stepOutputSelection: {},
  menu: { open: false, anchor: 'context', query: '' },
  /* How much of each answer has been typed out, keyed by conversation and item.
     Persisted so a re-render — of which there are many per second during a scan
     — resumes the animation instead of restarting it. */
  typed: {},
};

Object.assign(ui, vscode.getState() || {});
/* State saved before these keys existed would otherwise leave them undefined. */
if (!ui.scrolls) ui.scrolls = {};
if (!ui.stepOutputSelection) ui.stepOutputSelection = {};

let input = null;
let commands = null;
let thread = null;
let menu = null;
let menuFilter = null;

function save() {
  vscode.setState({
    draft: ui.draft,
    draftToken: ui.draftToken,
    caret: ui.caret,
    focused: ui.focused,
    scrollTop: ui.scrollTop,
    atBottom: ui.atBottom,
    disclosures: ui.disclosures,
    scrolls: ui.scrolls,
    stepOutputSelection: ui.stepOutputSelection,
    menu: ui.menu,
    typed: ui.typed,
  });
}

/* Show one phase's output, and say which phase that is.
   \`seg\` is a segment id, or 'live'/undefined to follow the newest phase. The
   label matters as much as the pane: with the tabs gone, it is the only thing
   telling a reader that the terminal they are looking at belongs to the step
   they clicked three lines down rather than to whatever is running now. */
function showStepOutput(panel, stepId, seg) {
  const panes = [...panel.querySelectorAll('[data-step-output]')];
  const live = panes.find((pane) => pane.classList.contains('is-live'));
  const pinned = seg && seg !== 'live' ? panes.find((pane) => pane.dataset.seg === seg) : null;
  const shown = pinned || live;
  for (const pane of panes) pane.hidden = pane !== shown;

  const label = panel.querySelector('[data-phase-for]');
  if (label && shown) label.textContent = shown.dataset.phase || '';
  if (label) label.classList.toggle('pinned', Boolean(pinned));

  for (const tab of panel.querySelectorAll('.output-tab.live')) tab.classList.toggle('active', !pinned);
  for (const line of document.querySelectorAll('.log-line[data-step="' + stepId + '"]')) {
    line.classList.toggle('active', Boolean(pinned) && line.dataset.seg === seg);
  }
}

/* Read the live DOM back into \`ui\` before it is thrown away. */
function capture() {
  if (input) {
    ui.draft = input.value;
    ui.caret = input.selectionStart;
    ui.focused = document.activeElement === input;
  }
  if (thread) {
    ui.scrollTop = thread.scrollTop;
    ui.atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 24;
  }
  if (menu) {
    ui.menu = {
      open: !menu.hidden,
      anchor: menu.dataset.anchor || 'context',
      query: menuFilter ? menuFilter.value : '',
    };
  }
  save();
}

function grow() {
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
}

/* ------------------------------------------------------------------ */
/* The typewriter                                                      */
/* ------------------------------------------------------------------ */

/* Answers arrive complete — the host has the whole string before it renders
   anything — and dropping a screen of prose into the panel in one frame reads
   as a stall followed by a wall of text. Typing it out instead means the panel
   is visibly working from the first character, and the developer starts reading
   the first line while the rest lands.

   It types the *rendered* markup rather than the source, by walking the text
   nodes and trimming them: the headings, code spans and links are already in
   place, so nothing reflows as the text fills in.

   Only the newest answer types. Everything above it has been read already, and
   replaying a restored conversation would be a wait in front of known content.
   Progress is stored per message, so the many re-renders a running scan causes
   resume the animation rather than restarting it, and -1 means finished. */

let typing = null;

function textNodesIn(element) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}

function typewriter() {
  if (typing) { clearInterval(typing); typing = null; }

  const bodies = [...document.querySelectorAll('[data-type]')];
  const live = new Set(bodies.map((el) => el.dataset.type));
  for (const key of Object.keys(ui.typed)) if (!live.has(key)) delete ui.typed[key];

  const last = bodies[bodies.length - 1];
  for (const el of bodies) if (el !== last) ui.typed[el.dataset.type] = -1;
  if (!last) return;

  const key = last.dataset.type;
  const nodes = textNodesIn(last);
  const full = nodes.map((node) => node.nodeValue);
  const total = full.reduce((sum, text) => sum + text.length, 0);

  let shown = ui.typed[key] === undefined ? 0 : ui.typed[key];
  if (shown === -1 || shown >= total || total === 0) {
    ui.typed[key] = -1;
    return;
  }

  const reveal = (count) => {
    let left = count;
    nodes.forEach((node, index) => {
      const text = full[index];
      if (left >= text.length) { node.nodeValue = text; left -= text.length; }
      else { node.nodeValue = text.slice(0, left); left = 0; }
    });
  };

  // Sized so a long answer still finishes in about a second: the point is to
  // show work happening, not to make the developer watch an animation.
  const step = Math.max(2, Math.ceil(total / 70));
  reveal(shown);

  typing = setInterval(() => {
    if (!last.isConnected) { clearInterval(typing); typing = null; return; }

    shown = Math.min(total, shown + step);
    reveal(shown);
    ui.typed[key] = shown >= total ? -1 : shown;
    if (thread && ui.atBottom) thread.scrollTop = thread.scrollHeight;

    if (shown >= total) {
      clearInterval(typing);
      typing = null;
      save();
    }
  }, 16);
}

/* ------------------------------------------------------------------ */
/* Mounting                                                            */
/* ------------------------------------------------------------------ */

function mount() {
  input = document.getElementById('input');
  commands = document.getElementById('commands');
  thread = document.getElementById('thread');
  menu = document.getElementById('menu');
  menuFilter = document.getElementById('menu-filter');

  /* Disclosures. Each carries a stable key; what the developer chose is
     remembered against that key and reapplied, so a package they opened does
     not slam shut when the next one arrives. */
  for (const element of document.querySelectorAll('details[data-key]')) {
    const key = element.dataset.key;
    const remembered = ui.disclosures[key];
    if (remembered !== undefined) element.open = remembered;
    element.addEventListener('toggle', () => {
      ui.disclosures[key] = element.open;
      save();
    });
  }

  /* Step output: which phase's segment is showing. Unset (or 'live') means
     "whichever one is newest" and keeps following the run; picking a tab pins
     the view to that phase until "Live" is clicked again or the step ends. */
  for (const panel of document.querySelectorAll('.step-output')) {
    const stepId = panel.dataset.key.replace(/^stepout:/, '');
    showStepOutput(panel, stepId, ui.stepOutputSelection[stepId]);
  }

  /* The activity drawers scroll on their own now that they are capped, so they
     need the transcript's rule applied individually: follow the newest line
     while the reader is at the bottom, and hold still the moment they scroll
     up to read something — otherwise every re-render during a live fix would
     yank them back down mid-sentence. */
  for (const list of document.querySelectorAll('[data-scroll]')) {
    const key = list.dataset.scroll;
    const remembered = ui.scrolls[key];
    if (!remembered || remembered.atBottom) list.scrollTop = list.scrollHeight;
    else list.scrollTop = remembered.top;
    list.addEventListener('scroll', () => {
      ui.scrolls[key] = {
        top: list.scrollTop,
        atBottom: list.scrollHeight - list.scrollTop - list.clientHeight < 16,
      };
      save();
    });
  }

  /* Follow new content when already at the bottom, hold position otherwise —
     the rule every chat UI uses. */
  if (thread) {
    thread.scrollTop = ui.atBottom ? thread.scrollHeight : ui.scrollTop;
    thread.addEventListener('scroll', () => {
      ui.scrollTop = thread.scrollTop;
      ui.atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 24;
      save();
    });
  }

  if (input) {
    /* The host owns the draft only when it says so. It stamps a token whenever
       it sets the text itself — after a submit, after a rewind — and otherwise
       whatever is in the box belongs to the developer, who may have typed a
       character while this render was in flight. */
    const token = Number(input.dataset.token);
    if (token !== ui.draftToken) {
      ui.draftToken = token;
      ui.draft = input.value;
      ui.caret = input.value.length;
    } else {
      input.value = ui.draft;
    }

    grow();

    if (ui.focused) {
      input.focus();
      const caret = typeof ui.caret === 'number' ? Math.min(ui.caret, input.value.length) : input.value.length;
      input.setSelectionRange(caret, caret);
    }

    const remember = () => {
      ui.caret = input.selectionStart;
      ui.focused = document.activeElement === input;
      save();
    };

    input.addEventListener('blur', remember);
    input.addEventListener('focus', remember);
    input.addEventListener('keyup', remember);
    input.addEventListener('click', remember);

    input.addEventListener('input', () => {
      ui.draft = input.value;
      grow();
      syncCommands();
      remember();
      vscode.postMessage({ type: 'draft', text: input.value });
    });

    input.addEventListener('keydown', onComposerKey);
  }

  if (menu && menuFilter) {
    menuFilter.addEventListener('input', syncMenu);
    menuFilter.addEventListener('keydown', onMenuKey);

    /* Still open, still filtered, still anchored where it was. A menu that
       blinks out from under the pointer every time a package arrives is
       unusable, and packages arrive for as long as a scan runs. */
    if (ui.menu.open) {
      menu.hidden = false;
      menuFilter.value = ui.menu.query || '';
      anchorMenu(ui.menu.anchor || 'context');
      syncMenu();
      menuFilter.focus();
      menuFilter.setSelectionRange(menuFilter.value.length, menuFilter.value.length);
    } else {
      syncMenu();
    }
  }

  // Before the first paint of this body, so the untyped tail never flashes.
  typewriter();

  for (const slider of document.querySelectorAll('input[type="range"][data-action="slider"]')) {
    slider.addEventListener('input', () => previewSlider(slider));
    // Committed on release, not on every pixel: each commit is a settings
    // write, and the label already moves live.
    slider.addEventListener('change', () => {
      const values = (slider.dataset.values || '').split(',');
      const value = values[Number(slider.value)];
      if (value) vscode.postMessage({ type: 'menu', id: slider.dataset.id + ':' + value });
    });
  }
}

/* ------------------------------------------------------------------ */
/* Composer                                                            */
/* ------------------------------------------------------------------ */

function send() {
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  ui.draft = '';
  grow();
  hideCommands();
  save();
  vscode.postMessage({ type: 'submit', text });
}

function visibleCommands() {
  return commands ? [...commands.querySelectorAll('.command:not([hidden])')] : [];
}

function hideCommands() {
  if (!commands) return;
  commands.hidden = true;
  for (const button of commands.querySelectorAll('.command')) button.classList.remove('active');
}

/* Slash-command palette: filters as you type, Tab or Enter completes. */
function syncCommands() {
  if (!commands || !input) return;
  const value = input.value;
  if (!value.startsWith('/') || value.includes(' ')) {
    hideCommands();
    return;
  }
  let any = false;
  for (const button of commands.querySelectorAll('.command')) {
    const name = button.dataset.command || '';
    const match = name.startsWith(value.toLowerCase());
    button.hidden = !match;
    if (match) any = true;
  }
  commands.hidden = !any;
  const first = visibleCommands()[0];
  if (first) first.classList.add('active');
}

function moveActive(delta) {
  const items = visibleCommands();
  if (items.length === 0) return;
  const current = items.findIndex((item) => item.classList.contains('active'));
  const next = (current + delta + items.length) % items.length;
  items.forEach((item) => item.classList.remove('active'));
  items[next].classList.add('active');
  items[next].scrollIntoView({ block: 'nearest' });
}

function complete(name) {
  if (!input) return;
  input.value = name + ' ';
  ui.draft = input.value;
  hideCommands();
  input.focus();
  save();
}

function onComposerKey(event) {
  if (commands && !commands.hidden) {
    if (event.key === 'ArrowDown') { event.preventDefault(); moveActive(1); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); moveActive(-1); return; }
    if (event.key === 'Escape') { event.preventDefault(); hideCommands(); return; }
    if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
      const active = commands.querySelector('.command.active');
      if (active) { event.preventDefault(); complete(active.dataset.command); return; }
    }
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    send();
  }
}

/* ------------------------------------------------------------------ */
/* The menu                                                            */
/* ------------------------------------------------------------------ */

function menuItems() {
  return menu ? [...menu.querySelectorAll('.menu-item:not([hidden])')] : [];
}

function anchorMenu(anchor) {
  if (!menu) return;
  menu.dataset.anchor = anchor;

  const trigger = document.querySelector('[data-action="openMenu"][data-anchor="' + anchor + '"]');
  const composer = menu.parentElement;
  if (!trigger || !composer) return;

  // Drilling from the subscriptions into one subscription's models is opened by
  // a row inside the menu itself. Following that as an anchor would walk the
  // menu across the panel one step per click; it stays where it was opened.
  if (menu.contains(trigger)) return;

  /* Anchored to the control that opened it, then pulled back inside the panel
     if that would hang it off the edge — a menu half off-screen in a 200px
     sidebar is worse than one that is merely near its trigger. */
  const left = trigger.getBoundingClientRect().left - composer.getBoundingClientRect().left;
  menu.style.left = '0px';
  const width = menu.getBoundingClientRect().width;
  const max = Math.max(0, composer.clientWidth - width - 4);
  menu.style.left = Math.max(0, Math.min(left, max)) + 'px';
}

function openMenu(anchor) {
  if (!menu) return;
  menu.hidden = false;
  if (menuFilter) menuFilter.value = '';
  anchorMenu(anchor);
  syncMenu();
  ui.menu = { open: true, anchor, query: '' };
  save();
  if (menuFilter) {
    menuFilter.focus();
    menuFilter.select();
  }
}

function closeMenu(refocus) {
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  if (menuFilter) menuFilter.value = '';
  ui.menu = { open: false, anchor: ui.menu.anchor, query: '' };
  save();
  if (refocus && input) input.focus();
}

/* Only the sections belonging to the control that opened the menu are shown.
   The plus button offers context and nothing else; the model button offers that
   provider's models and nothing else. A control whose menu contains settings it
   does not name is a control with a misleading label. */
function syncMenu() {
  if (!menu) return;
  const anchor = menu.dataset.anchor || 'context';
  const query = (menuFilter ? menuFilter.value : '').trim().toLowerCase();
  const words = query.split(/\\s+/).filter(Boolean);

  for (const section of menu.querySelectorAll('.menu-section')) {
    const mine = section.dataset.anchor === anchor;
    for (const item of section.querySelectorAll('.menu-item')) {
      const haystack = item.dataset.search || '';
      item.hidden = !mine || !words.every((word) => haystack.includes(word));
      item.classList.remove('active');
    }
    // A heading with nothing under it is a lie about what is available; a
    // section that is only a slider has no items and must still show.
    const items = section.querySelectorAll('.menu-item:not([hidden])').length;
    section.hidden = !mine || (items === 0 && !section.querySelector('.slider'));
  }

  const items = menuItems();
  const empty = menu.querySelector('.menu-empty');
  if (empty) empty.hidden = items.length > 0 || Boolean(menu.querySelector('.menu-section:not([hidden]) .slider'));
  if (query && items[0]) items[0].classList.add('active');

  ui.menu = { open: !menu.hidden, anchor, query };
  save();
}

function moveMenu(delta) {
  const items = menuItems();
  if (items.length === 0) return;
  const current = items.findIndex((item) => item.classList.contains('active'));
  const next = (current + delta + items.length) % items.length;
  items.forEach((item) => item.classList.remove('active'));
  items[next].classList.add('active');
  items[next].scrollIntoView({ block: 'nearest' });
}

function onMenuKey(event) {
  if (event.key === 'ArrowDown') { event.preventDefault(); moveMenu(1); return; }
  if (event.key === 'ArrowUp') { event.preventDefault(); moveMenu(-1); return; }
  if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); return; }
  if (event.key === 'Enter') {
    event.preventDefault();
    const active = menu.querySelector('.menu-item.active') || menuItems()[0];
    if (active) active.click();
  }
}

/* The dial's label follows the handle, so the developer sees what a position
   means before they let go of it. */
function previewSlider(slider) {
  const index = Number(slider.value);
  const wrapper = slider.closest('.slider');
  if (!wrapper) return;

  const ticks = [...wrapper.querySelectorAll('.slider-ticks span')];
  ticks.forEach((tick, i) => tick.classList.toggle('on', i === index));

  const detail = wrapper.querySelector('.slider-detail');
  if (detail) {
    const details = (detail.dataset.details || '').split('|');
    if (details[index]) detail.textContent = details[index];
  }
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

// Actions that answer locally or navigate away instantly — no round trip to
// the extension host worth locking the UI over, and \`stop\` has to stay live
// precisely because something else is already pending. \`openFindingDiff\` is
// deliberately absent: it can fetch and extract a real published package to
// widen the declaration into context, which is real network- and CPU-bound
// time, and a button with no spinner over that wait reads as a click that did
// nothing — the same reason \`openVersionDiff\` was never local either.
const LOCAL_ACTIONS = new Set([
  'slider', 'submit', 'complete', 'openMenu', 'openUrl', 'openFile', 'openDiff',
  'selectVersion', 'pickVersion', 'stop', 'selectOutput',
]);

// True from the moment a server-bound action is clicked until the next
// \`render\` message replaces the DOM (or a timeout gives up on waiting for
// one). A click that visibly did nothing — because the extension host took a
// moment to respond — is what makes someone click twice, firing the same
// scan or fix a second time. Locking every action button the instant one is
// clicked, and putting a spinner on the one that was, closes that gap.
let actionPending = false;
let actionPendingTimeout = null;

function lockActions(clicked) {
  actionPending = true;
  document.querySelectorAll('button[data-action]').forEach((btn) => {
    if (btn.dataset.action !== 'stop') btn.disabled = true;
  });
  if (clicked instanceof HTMLButtonElement) clicked.classList.add('is-loading');
  clearTimeout(actionPendingTimeout);
  // A render normally arrives within a second or two; if the host never
  // answers (a bug, a crashed run), buttons stuck disabled forever would be
  // worse than the double-click this is meant to prevent.
  actionPendingTimeout = setTimeout(unlockActions, 20000);
}

function unlockActions() {
  actionPending = false;
  clearTimeout(actionPendingTimeout);
  document.querySelectorAll('button[data-action].is-loading').forEach((btn) => btn.classList.remove('is-loading'));
  document.querySelectorAll('button[data-action]:disabled').forEach((btn) => { btn.disabled = false; });
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');

  // Anywhere else dismisses the menu, the way a menu is supposed to behave.
  if (menu && !menu.hidden && !menu.contains(event.target) && (!target || target.dataset.action !== 'openMenu')) {
    closeMenu(false);
  }

  if (!target) return;

  const action = target.dataset.action;

  // The dial handles its own events; a click on it is a drag, not a command.
  if (action === 'slider') return;

  // Which phase's output a step's terminal shows is never the host's business
  // — it does not change what happened, only which part of it is on screen —
  // so this answers itself and re-mounts rather than round-tripping.
  if (action === 'selectOutput') {
    const stepId = target.dataset.step;
    ui.stepOutputSelection[stepId] = target.dataset.seg;
    save();
    for (const panel of document.querySelectorAll('.step-output[data-key="stepout:' + stepId + '"]')) {
      showStepOutput(panel, stepId, target.dataset.seg);
    }
    return;
  }

  // A second click on a server-bound action while the first is still in
  // flight is a double-fire, not a new request — the buttons should already
  // be disabled, but a click that lands in the same tick as the disable can
  // still slip through.
  if (actionPending && !LOCAL_ACTIONS.has(action)) return;

  if (action === 'submit') { send(); return; }
  if (action === 'complete') { complete(target.dataset.command); return; }
  if (action === 'openMenu') {
    const anchor = target.dataset.anchor || 'context';
    const open = menu && !menu.hidden;
    if (open && menu.dataset.anchor === anchor) closeMenu(true);
    else openMenu(anchor);
    return;
  }
  if (action === 'menu') {
    closeMenu(true);
    lockActions(target);
    vscode.postMessage({ type: 'menu', id: target.dataset.id });
    return;
  }
  if (action === 'run') {
    lockActions(target);
    vscode.postMessage({ type: 'submit', text: target.dataset.command });
    return;
  }

  // \`stop\` stays out of \`lockActions\` — the rest of the UI must not lock,
  // since the run it is cancelling is what is already holding it busy — but
  // the click still needs to look like it did something immediately, or a
  // stop that takes a moment to land reads as a stop that did not register.
  if (action === 'stop' && target instanceof HTMLButtonElement) {
    target.classList.add('is-loading');
    target.disabled = true;
  }

  if (!LOCAL_ACTIONS.has(action)) lockActions(target);

  vscode.postMessage({
    type: action,
    id: target.dataset.id,
    value: target.dataset.value,
    command: target.dataset.command,
    path: target.dataset.path,
    order: target.dataset.order ? Number(target.dataset.order) : undefined,
    mode: target.dataset.mode,
    file: target.dataset.file,
    line: target.dataset.line ? Number(target.dataset.line) : undefined,
    url: target.dataset.url,
    version: target.dataset.version,
  });
});

window.addEventListener('message', (event) => {
  const data = event.data;

  if (data?.type === 'full-render') {
    unlockActions();
    capture();
    root.innerHTML = data.body;
    mount();
    return;
  }
  if (data?.type === 'thread-append' && thread) {
    const bottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 24;
    thread.insertAdjacentHTML('beforeend', data.html);
    if (bottom) thread.scrollTop = thread.scrollHeight;
    typewriter();
    unlockActions();
    return;
  }
  if (data?.type === 'thread-replace' && thread) {
    const bottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 24;
    const id = String(data.id).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const previous = thread.querySelector('[data-thread-id="' + id + '"]');
    if (previous) previous.outerHTML = data.html;
    if (bottom) thread.scrollTop = thread.scrollHeight;
    typewriter();
    unlockActions();
    return;
  }
  if (data?.type === 'thread-reset' && thread) {
    const bottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 24;
    const template = document.createElement('template');
    template.innerHTML = data.html;
    const next = template.content.querySelector('#thread');
    if (next) thread.innerHTML = next.innerHTML;
    if (bottom) thread.scrollTop = thread.scrollHeight;
    typewriter();
    unlockActions();
    return;
  }
  if (data?.type === 'welcome-replace' && thread) {
    const current = document.getElementById('welcome-region');
    if (current) current.outerHTML = data.html;
    return;
  }
  if (data?.type === 'composer-replace') {
    capture();
    const current = document.getElementById('composer-region');
    if (current) current.outerHTML = data.html;
    // Only the composer was replaced; retain transcript nodes and initialise
    // the controls it owns without rebuilding the thread.
    input = document.getElementById('input');
    commands = document.getElementById('commands');
    menu = document.getElementById('menu');
    menuFilter = document.getElementById('menu-filter');
    if (input) { input.value = ui.draft; grow(); input.addEventListener('keydown', onComposerKey); input.addEventListener('input', () => { ui.draft = input.value; grow(); syncCommands(); vscode.postMessage({ type: 'draft', text: input.value }); }); }
    unlockActions();
    return;
  }
  if (data?.type === 'openMenu') { openMenu(data.anchor || 'context'); return; }
  if (!input) return;
  if (data?.type === 'insert') {
    const start = input.selectionStart ?? input.value.length;
    input.value = input.value.slice(0, start) + data.text + input.value.slice(start);
    ui.draft = input.value;
    grow();
    input.focus();
    input.setSelectionRange(start + data.text.length, start + data.text.length);
    save();
  }
  if (data?.type === 'focus') input.focus();
});

mount();

// The host holds the transcript; this tells it there is somewhere to put it.
// Sent last so a webview restored from a reload is repainted rather than left
// showing whatever markup it was serialised with.
vscode.postMessage({ type: 'ready' });
`;
