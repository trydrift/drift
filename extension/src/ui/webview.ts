import type { Attachment, SessionEffort, SessionMode, SessionPermission, ThreadItem } from '../session.js';
import { describeEffort, describeMode, describePermission } from '../session.js';
import { describeSeverity, severityOf, type UpgradeCandidate, type UpgradeSeverity } from '../upgrades.js';
import type { ReviewGroup, ReviewTotals } from '../review/store.js';
import type { BreakingChange, Evidence, RemediationPlan } from '../../../src/types.js';

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
  description: string;
}

export interface ViewModel {
  nonce: string;
  repoLabel: string | null;
  signedInLabel: string | null;
  agents: AgentChoice[];
  agentId: string;
  agentLabel: string;
  mode: SessionMode;
  effort: SessionEffort;
  permission: SessionPermission;
  attachments: readonly Attachment[];
  thread: readonly ThreadItem[];
  /** Keyed by candidate id, for `packages` thread items. */
  candidates: Record<string, UpgradeCandidate>;
  review: { groups: readonly ReviewGroup[]; totals: ReviewTotals } | null;
  busy: boolean;
  awaitingAnswer: boolean;
  commands: readonly SlashCommand[];
  /** Restored after a re-render so typing is never lost. */
  draft: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: '/scan', description: 'Check every dependency for a newer version and see what would break' },
  { name: '/recent', description: 'Analyse the dependency change already in your git history' },
  { name: '/upgrade', args: '<package>', description: 'Upgrade one package and check the impact' },
  { name: '/fix', args: '[package]', description: 'Let your AI agent fix the affected code' },
  { name: '/review', description: 'Show changes waiting to be kept or undone' },
  { name: '/agent', description: 'Choose which AI agent does the work' },
  { name: '/clear', description: 'Start a new session' },
  { name: '/help', description: 'What Drift can do' },
];

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
  <div class="thread" id="thread">
    ${vm.thread.length === 0 ? renderWelcome(vm) : vm.thread.map((item) => renderItem(item, vm)).join('')}
  </div>

  ${renderComposer(vm)}

  <script nonce="${vm.nonce}">${SCRIPT}</script>
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/* Welcome                                                             */
/* ------------------------------------------------------------------ */

function renderWelcome(vm: ViewModel): string {
  return `<div class="welcome">
    <div class="mark">${LOGO}</div>
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
        : `<p class="foot warn">No AI agent found yet. Drift can still analyse and prove impact — <a data-action="pickAgent">choose an agent</a> when you want fixes.</p>`
    }
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Thread items                                                        */
/* ------------------------------------------------------------------ */

function renderItem(item: ThreadItem, vm: ViewModel): string {
  switch (item.kind) {
    case 'user':
      return `<div class="turn user">
        <div class="who">${ICON_USER}<span>You</span></div>
        <div class="bubble">${renderMarkdown(item.text)}</div>
        ${
          item.attachments.length
            ? `<div class="chips small">${item.attachments.map((a) => `<span class="chip">${attachmentIcon(a)}${escapeHtml(a.label)}</span>`).join('')}</div>`
            : ''
        }
      </div>`;

    case 'assistant':
      return `<div class="turn assistant">
        <div class="who">${LOGO_SMALL}<span>Drift</span></div>
        <div class="body markdown">${renderMarkdown(item.text)}</div>
      </div>`;

    case 'notice':
      return `<div class="notice ${item.tone}">${noticeIcon(item.tone)}<div class="markdown">${renderMarkdown(item.text)}</div></div>`;

    case 'step':
      return renderStep(item);

    case 'packages':
      return renderPackages(item, vm);

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
      ${item.detail ? `<span class="detail">${escapeHtml(item.detail)}</span>` : ''}
    </div>
    ${item.total > 0 ? `<div class="bar"><span style="width:${pct}%"></span></div>` : ''}
    ${
      item.log.length > 1
        ? `<details class="log"><summary>${item.log.length} step${item.log.length === 1 ? '' : 's'}</summary><ol>${item.log
            .slice(-60)
            .map((line) => `<li>${escapeHtml(line)}</li>`)
            .join('')}</ol></details>`
        : ''
    }
  </div>`;
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

function renderPackages(item: Extract<ThreadItem, { kind: 'packages' }>, vm: ViewModel): string {
  const candidates = item.ids.map((id) => vm.candidates[id]).filter((c): c is UpgradeCandidate => Boolean(c));
  if (candidates.length === 0) {
    return `<div class="turn assistant"><div class="who">${LOGO_SMALL}<span>Drift</span></div><div class="body markdown">${renderMarkdown(item.headline)}</div></div>`;
  }

  const affected = candidates.filter((c) => severityOf(c) === 'affected');
  const safe = candidates.filter((c) => severityOf(c) !== 'affected' && severityOf(c) !== 'error');
  const failed = candidates.filter((c) => severityOf(c) === 'error');

  return `<div class="turn assistant">
    <div class="who">${LOGO_SMALL}<span>Drift</span></div>
    <div class="body markdown">${renderMarkdown(item.headline)}</div>

    <div class="result-tabs">
      ${tally(affected.length, 'need your attention', 'affected')}
      ${tally(safe.length, 'safe to upgrade', 'clean')}
      ${failed.length ? tally(failed.length, 'could not be checked', 'error') : ''}
    </div>

    ${
      affected.length
        ? `<section class="group">
            <h4>${ICON_ALERT} Affects your code</h4>
            ${affected.map((c) => renderCandidate(c, true)).join('')}
            ${
              affected.length > 1
                ? `<button class="primary wide" data-action="fixAll">Fix all ${affected.length} with ${escapeHtml(vm.agentLabel)}</button>`
                : ''
            }
          </section>`
        : ''
    }

    ${
      safe.length
        ? `<details class="group collapsed">
            <summary><h4>${ICON_CHECK} Safe to upgrade <small>${safe.length}</small></h4></summary>
            ${safe.map((c) => renderCandidate(c, false)).join('')}
          </details>`
        : ''
    }

    ${
      failed.length
        ? `<details class="group collapsed">
            <summary><h4>${ICON_ERROR} Could not check <small>${failed.length}</small></h4></summary>
            ${failed.map((c) => renderCandidate(c, false)).join('')}
          </details>`
        : ''
    }
  </div>`;
}

function tally(count: number, label: string, tone: string): string {
  return `<div class="tally ${tone}"><b>${count}</b><span>${escapeHtml(label)}</span></div>`;
}

function renderCandidate(candidate: UpgradeCandidate, open: boolean): string {
  const severity = severityOf(candidate);
  const busy = candidate.status === 'checking' || candidate.status === 'upgrading';

  return `<details class="pkg ${severity}" ${open ? 'open' : ''}>
    <summary>
      <span class="dot ${severity}"></span>
      <span class="pkg-name">
        <b>${escapeHtml(candidate.name)}</b>
        <span class="versions">${escapeHtml(candidate.current)} <span class="arrow">→</span> ${escapeHtml(candidate.selected)}</span>
      </span>
      <span class="verdict ${severity}">${escapeHtml(busy ? busyLabel(candidate) : shortVerdict(candidate, severity))}</span>
    </summary>

    <div class="pkg-body">
      <p class="verdict-long">${escapeHtml(candidate.error ?? candidate.summary)}</p>

      <div class="pkg-target">
        <label>
          <span>Target version</span>
          <select data-action="selectVersion" data-id="${escapeAttr(candidate.id)}">
            ${candidate.versions
              .map(
                (version) =>
                  `<option value="${escapeAttr(version)}" ${version === candidate.selected ? 'selected' : ''}>${escapeHtml(version)}${version === candidate.safeLatest ? ' — within your range' : ''}${version === candidate.latest ? ' — latest' : ''}</option>`,
              )
              .join('')}
          </select>
        </label>
        <span class="kind">${escapeHtml(candidate.kind)}</span>
      </div>

      ${candidate.plan ? renderCandidateDetail(candidate, candidate.plan) : ''}

      <div class="pkg-actions">
        <button data-action="upgrade" data-id="${escapeAttr(candidate.id)}" data-mode="safe" ${candidate.safeLatest ? '' : 'disabled'} title="${candidate.safeLatest ? `Install ${candidate.safeLatest}, which satisfies the range already in package.json` : 'No newer version fits the range in package.json'}">
          Upgrade
        </button>
        <button data-action="upgrade" data-id="${escapeAttr(candidate.id)}" data-mode="force" title="Install ${escapeAttr(candidate.latest)} and widen the range in package.json">
          Upgrade to ${escapeHtml(candidate.latest)}
        </button>
        ${
          candidate.impactCount > 0
            ? `<button class="primary" data-action="fixPackage" data-id="${escapeAttr(candidate.id)}">Fix ${candidate.impactCount} site${candidate.impactCount === 1 ? '' : 's'}</button>`
            : ''
        }
      </div>
    </div>
  </details>`;
}

function busyLabel(candidate: UpgradeCandidate): string {
  return candidate.status === 'upgrading' ? 'Installing…' : 'Checking…';
}

function shortVerdict(candidate: UpgradeCandidate, severity: UpgradeSeverity): string {
  switch (severity) {
    case 'affected':
      return `${candidate.impactCount} site${candidate.impactCount === 1 ? '' : 's'} here`;
    case 'upstream-only':
      return 'Safe here';
    case 'clean':
      return 'Safe';
    case 'error':
      return 'Unknown';
  }
}

function renderCandidateDetail(candidate: UpgradeCandidate, plan: RemediationPlan): string {
  const matched = plan.breakingChanges.filter((change) =>
    plan.impactSites.some((site) => site.breakingChangeId === change.id),
  );
  const unmatched = plan.breakingChanges.filter(
    (change) => !plan.impactSites.some((site) => site.breakingChangeId === change.id),
  );

  return `<div class="detail">
    ${matched.map((change) => renderBreak(change, plan, true)).join('')}

    ${
      unmatched.length
        ? `<details class="sub">
            <summary>${unmatched.length} upstream change${unmatched.length === 1 ? '' : 's'} that ${unmatched.length === 1 ? 'does' : 'do'} not touch your code</summary>
            <p class="hint">Drift found ${unmatched.length === 1 ? 'this' : 'these'} in the release notes, then searched this repository for the affected APIs and found nothing. Listed so you can check the reasoning, not because there is anything to do.</p>
            ${unmatched.map((change) => renderBreak(change, plan, false)).join('')}
          </details>`
        : ''
    }

    ${
      plan.evidence.length
        ? `<details class="sub">
            <summary>Evidence Drift read <small>${plan.evidence.length} source${plan.evidence.length === 1 ? '' : 's'}</small></summary>
            ${renderEvidence(plan.evidence)}
          </details>`
        : ''
    }
  </div>`;
}

function renderBreak(change: BreakingChange, plan: RemediationPlan, expanded: boolean): string {
  const sites = plan.impactSites.filter((site) => site.breakingChangeId === change.id);
  const evidence = plan.evidence.filter((entry) => change.citations.includes(entry.id));

  return `<details class="break" ${expanded ? 'open' : ''}>
    <summary>
      <span class="confidence ${change.confidence}">${escapeHtml(change.confidence)}</span>
      <span class="break-summary">${escapeHtml(change.summary)}</span>
    </summary>
    <div class="break-body">
      ${change.symbols.length ? `<p class="symbols">${change.symbols.map((s) => `<code>${escapeHtml(s)}</code>`).join(' ')}</p>` : ''}
      <p class="fix"><b>Fix:</b> ${renderMarkdown(change.remediation)}</p>
      ${
        sites.length
          ? `<ul class="sites">${sites
              .slice(0, 20)
              .map(
                (site) =>
                  `<li><a data-action="openFile" data-file="${escapeAttr(site.file)}" data-line="${site.line}"><code>${escapeHtml(site.file)}:${site.line}</code></a><span>${escapeHtml(site.excerpt)}</span></li>`,
              )
              .join('')}${sites.length > 20 ? `<li class="hint">…and ${sites.length - 20} more</li>` : ''}</ul>`
          : ''
      }
      ${evidence.length ? renderEvidence(evidence) : ''}
    </div>
  </details>`;
}

function renderEvidence(evidence: readonly Evidence[]): string {
  return `<div class="evidence">
    ${evidence
      .slice(0, 6)
      .map(
        (entry) => `<details>
          <summary>
            <span class="source">${escapeHtml(entry.source)}</span>
            ${
              entry.url
                ? `<a data-action="openUrl" data-url="${escapeAttr(entry.url)}">${escapeHtml(entry.title)}</a>`
                : `<span>${escapeHtml(entry.title)}</span>`
            }
          </summary>
          <div class="markdown quote">${renderMarkdown(entry.content.slice(0, 1600))}</div>
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

  return `<div class="change-group">
    <div class="group-head">
      ${ICON_DIFF}
      <div><b>${escapeHtml(group.title)}</b><small>${group.files.length} file${group.files.length === 1 ? '' : 's'}</small></div>
      <div class="group-actions">
        <button data-action="undoGroup" data-order="${group.order}">Undo</button>
        <button data-action="keepGroup" data-order="${group.order}">Keep &amp; commit</button>
      </div>
    </div>
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

function renderComposer(vm: ViewModel): string {
  const placeholder = vm.awaitingAnswer
    ? 'Type your answer, or pick an option above…'
    : vm.busy
      ? 'Drift is working…'
      : 'Ask about a dependency, or type / for commands';

  return `<div class="composer ${vm.awaitingAnswer ? 'answering' : ''}">
    ${
      vm.attachments.length
        ? `<div class="chips">
            ${vm.attachments
              .map(
                (a) =>
                  `<span class="chip">${attachmentIcon(a)}${escapeHtml(a.label)}<button data-action="detach" data-value="${escapeAttr(a.value)}" aria-label="Remove">×</button></span>`,
              )
              .join('')}
            <button class="chip ghost" data-action="attach">${ICON_ATTACH}Add context</button>
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

    <textarea id="input" rows="1" placeholder="${escapeAttr(placeholder)}">${escapeHtml(vm.draft)}</textarea>

    <div class="composer-bar">
      ${vm.attachments.length === 0 ? `<button class="flat" data-action="attach" title="Attach a file or folder as context">${ICON_ATTACH}</button>` : ''}

      <label class="picker" title="Ask explains and proposes. Agent edits your files.">
        <select data-action="setMode">
          ${(['agent', 'ask'] as SessionMode[])
            .map((mode) => `<option value="${mode}" ${vm.mode === mode ? 'selected' : ''}>${describeMode(mode)}</option>`)
            .join('')}
        </select>
      </label>

      <label class="picker" title="Which AI agent does the work">
        <select data-action="setAgent">
          <option value="auto" ${vm.agentId === 'auto' ? 'selected' : ''}>Auto — best available</option>
          ${vm.agents
            .filter((a) => a.available)
            .map(
              (a) =>
                `<option value="${escapeAttr(a.id)}" ${vm.agentId === a.id ? 'selected' : ''}>${escapeHtml(a.label)}</option>`,
            )
            .join('')}
          <option value="__pick">Set up an agent…</option>
        </select>
      </label>

      <label class="picker" title="How widely Drift looks: Quick checks runtime majors only, Thorough includes dev dependencies and patch releases">
        <select data-action="setEffort">
          ${(['quick', 'balanced', 'thorough'] as SessionEffort[])
            .map(
              (effort) =>
                `<option value="${effort}" ${vm.effort === effort ? 'selected' : ''}>${describeEffort(effort)}</option>`,
            )
            .join('')}
        </select>
      </label>

      <label class="picker" title="What the agent may do without asking">
        <select data-action="setPermission">
          ${(['ask', 'auto-edit', 'full-auto'] as SessionPermission[])
            .map(
              (permission) =>
                `<option value="${permission}" ${vm.permission === permission ? 'selected' : ''}>${describePermission(permission)}</option>`,
            )
            .join('')}
        </select>
      </label>

      <span class="spacer"></span>

      ${
        vm.busy
          ? `<button class="stop" data-action="stop" title="Stop">${ICON_STOP}</button>`
          : `<button class="send" data-action="submit" title="Send (Enter)">${ICON_SEND}</button>`
      }
    </div>
  </div>`;
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

export function renderMarkdown(text: string): string {
  const escaped = escapeHtml(text);
  const out: string[] = [];
  let inList = false;
  let inCode = false;
  let code: string[] = [];

  const closeList = () => {
    if (!inList) return '';
    inList = false;
    return '</ul>';
  };

  for (const raw of escaped.split(/\r?\n/)) {
    const line = raw.trim();

    if (line.startsWith('```')) {
      if (inCode) {
        out.push(`<pre><code>${code.join('\n')}</code></pre>`);
        code = [];
        inCode = false;
      } else {
        out.push(closeList());
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      code.push(raw);
      continue;
    }

    if (!line) {
      out.push(closeList());
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      out.push(closeList(), `<h4>${inlineMarkdown(heading[2]!)}</h4>`);
      continue;
    }

    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inlineMarkdown(bullet[1]!)}</li>`);
      continue;
    }

    out.push(closeList(), `<p>${inlineMarkdown(line)}</p>`);
  }

  if (inCode && code.length) out.push(`<pre><code>${code.join('\n')}</code></pre>`);
  out.push(closeList());
  return out.filter(Boolean).join('');
}

function inlineMarkdown(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1<em>$2</em>')
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      (_match, label: string, url: string) => `<a data-action="openUrl" data-url="${escapeAttr(url)}">${label}</a>`,
    );
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
const ICON_SEND = svg('<path d="M8 2 3 7h3.2v7h3.6V7H13L8 2z"/>', 16);
const ICON_STOP = svg('<rect x="4" y="4" width="8" height="8" rx="1"/>', 16);
const ICON_SEARCH = svg('<path d="M10.5 9.5 14 13l-1 1-3.5-3.5A5 5 0 1 1 10.5 9.5zM6.5 3a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z"/>', 16);
const ICON_HISTORY = svg('<path d="M8 1.5A6.5 6.5 0 1 0 14.5 8H13A5 5 0 1 1 8 3v2.5L11.5 3.2 8 1V1.5zM7.25 5v4l3.2 1.9.75-1.25L8.75 8.3V5h-1.5z"/>', 16);
const ICON_DIFF = svg('<path d="M4.5 1.5h1.5v3H9v1.5H6v3H4.5v-3h-3V4.5h3v-3zM8 11h6v1.5H8V11z"/>');
const ICON_COMMIT = svg('<path d="M8 5a3 3 0 0 1 2.9 2.25H15v1.5h-4.1A3 3 0 0 1 5.1 8.75H1v-1.5h4.1A3 3 0 0 1 8 5z"/>');

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
  background: var(--vscode-textCodeBlock-background);
  border-radius: 3px;
  padding: 1px 4px;
}
pre {
  margin: 6px 0;
  padding: 8px;
  overflow: auto;
  max-height: 240px;
  background: var(--vscode-textCodeBlock-background);
  border-radius: 5px;
}
pre code { background: none; padding: 0; }
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
button.wide { width: 100%; margin-top: 6px; }
select {
  font: inherit;
  border: 1px solid var(--vscode-dropdown-border, transparent);
  color: var(--vscode-dropdown-foreground);
  background: var(--vscode-dropdown-background);
  border-radius: 4px;
  padding: 2px 4px;
  max-width: 100%;
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

/* Welcome --------------------------------------------------------- */
.welcome { text-align: center; padding: 22px 6px 6px; }
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
.step-head { display: flex; align-items: center; gap: 7px; }
.step-head .count { margin-left: auto; font-size: 11px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
.step.done .step-head svg { color: var(--vscode-testing-iconPassed); }
.step.failed .step-head svg { color: var(--vscode-editorError-foreground); }
.step-now {
  display: flex;
  gap: 6px;
  margin: 4px 0 0 21px;
  font-size: 11px;
  min-width: 0;
}
.step-now .phase { color: var(--vscode-foreground); white-space: nowrap; }
.step-now .detail {
  color: var(--vscode-descriptionForeground);
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
  padding-left: 18px;
  max-height: 170px;
  overflow: auto;
  color: var(--vscode-descriptionForeground);
}
.spinner {
  width: 12px;
  height: 12px;
  flex: 0 0 auto;
  border-radius: 50%;
  border: 1.6px solid var(--vscode-panel-border);
  border-top-color: var(--vscode-progressBar-background);
  animation: spin .8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

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
.result-tabs { display: flex; gap: 6px; margin: 8px 0; }
.tally {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 5px;
  padding: 6px 8px;
  background: var(--vscode-editorWidget-background);
}
.tally b { display: block; font-size: 16px; line-height: 1.1; }
.tally span { display: block; font-size: 10px; color: var(--vscode-descriptionForeground); }
.tally.affected b { color: var(--vscode-editorWarning-foreground); }
.tally.clean b { color: var(--vscode-testing-iconPassed); }
.tally.error b { color: var(--vscode-editorError-foreground); }
.group { margin-top: 10px; }
.group > h4, .group > summary h4 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  color: var(--vscode-descriptionForeground);
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: .04em;
}
.group > summary { cursor: pointer; list-style: none; }
.group > summary::-webkit-details-marker { display: none; }
.group > summary h4 small { text-transform: none; letter-spacing: 0; }
.pkg {
  border: 1px solid var(--vscode-panel-border);
  border-left: 2px solid var(--vscode-descriptionForeground);
  border-radius: 5px;
  background: var(--vscode-editorWidget-background);
  margin-bottom: 5px;
  overflow: hidden;
}
.pkg.affected { border-left-color: var(--vscode-editorWarning-foreground); }
.pkg.clean, .pkg.upstream-only { border-left-color: var(--vscode-testing-iconPassed); }
.pkg.error { border-left-color: var(--vscode-editorError-foreground); }
.pkg > summary {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  padding: 7px 9px;
  cursor: pointer;
  list-style: none;
}
.pkg > summary::-webkit-details-marker { display: none; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--vscode-testing-iconPassed); }
.dot.affected { background: var(--vscode-editorWarning-foreground); }
.dot.error { background: var(--vscode-editorError-foreground); }
.pkg-name { min-width: 0; display: flex; flex-direction: column; }
.pkg-name b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.versions { font-size: 11px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
.versions .arrow { opacity: .6; }
.verdict {
  font-size: 10px;
  white-space: nowrap;
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
.pkg-body { padding: 0 9px 9px; border-top: 1px solid var(--vscode-panel-border); }
.verdict-long { margin: 8px 0; color: var(--vscode-descriptionForeground); }
.pkg-target { display: flex; gap: 8px; align-items: end; margin-bottom: 8px; }
.pkg-target label { display: grid; gap: 3px; flex: 1; min-width: 0; font-size: 11px; color: var(--vscode-descriptionForeground); }
.pkg-target .kind { font-size: 10px; color: var(--vscode-descriptionForeground); padding-bottom: 4px; }
.pkg-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.pkg-actions button { flex: 1 1 auto; white-space: nowrap; }
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
ul.sites { margin: 6px 0; padding: 0; list-style: none; display: grid; gap: 5px; }
ul.sites li { display: grid; gap: 1px; overflow-wrap: anywhere; }
ul.sites span { font-size: 11px; color: var(--vscode-descriptionForeground); }
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
  flex: 0 0 auto;
  margin: 6px 10px 10px;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: 8px;
  background: var(--vscode-input-background);
  padding: 6px 8px 5px;
}
.composer:focus-within { border-color: var(--vscode-focusBorder); }
.composer.answering { border-color: var(--vscode-focusBorder); }
.chips { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 5px; }
.chips.small { margin: 0 0 0 0; }
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 10px;
  padding: 1px 7px;
  color: var(--vscode-descriptionForeground);
  max-width: 100%;
}
.chip button {
  border: 0;
  background: none;
  padding: 0 0 0 2px;
  color: inherit;
  font-size: 12px;
  line-height: 1;
}
.chip.ghost { cursor: pointer; background: none; }
#input {
  font: inherit;
  display: block;
  width: 100%;
  min-height: 22px;
  max-height: 160px;
  resize: none;
  border: 0;
  outline: none;
  padding: 3px 0;
  color: var(--vscode-input-foreground);
  background: transparent;
}
.composer-bar { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.composer-bar .spacer { flex: 1 1 auto; }
.picker select {
  border-color: transparent;
  background: transparent;
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
  padding: 2px 2px;
  max-width: 118px;
}
.picker select:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, transparent); }
button.flat {
  border: 0;
  background: none;
  color: var(--vscode-descriptionForeground);
  padding: 3px 4px;
}
button.flat:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, transparent); }
button.send, button.stop {
  width: 26px;
  height: 26px;
  padding: 0;
  display: inline-grid;
  place-items: center;
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
}
button.stop { background: var(--vscode-editorError-foreground); }
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
button.command {
  border: 0;
  background: none;
  text-align: left;
  display: flex;
  flex-direction: column;
  padding: 4px 6px;
  border-radius: 4px;
}
button.command[hidden] { display: none; }
button.command:hover, button.command.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
button.command .args { color: var(--vscode-descriptionForeground); font-weight: 400; }
button.command small { font-size: 10px; }
`;

/* ------------------------------------------------------------------ */
/* Webview script                                                      */
/* ------------------------------------------------------------------ */

const SCRIPT = `
const vscode = acquireVsCodeApi();
const input = document.getElementById('input');
const commands = document.getElementById('commands');
const thread = document.getElementById('thread');

const state = vscode.getState() || {};

/* Keep the scroll position across re-renders, but follow new content when the
   developer is already at the bottom — the same rule every chat UI uses. */
if (thread) {
  const atBottom = state.atBottom !== false;
  thread.scrollTop = atBottom ? thread.scrollHeight : (state.scrollTop || 0);
  thread.addEventListener('scroll', () => {
    const bottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 24;
    vscode.setState({ ...vscode.getState(), scrollTop: thread.scrollTop, atBottom: bottom });
  });
}

function grow() {
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
}

function send() {
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  grow();
  hideCommands();
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
  hideCommands();
  input.focus();
}

if (input) {
  grow();
  input.focus();

  input.addEventListener('input', () => {
    grow();
    syncCommands();
    vscode.postMessage({ type: 'draft', text: input.value });
  });

  input.addEventListener('keydown', (event) => {
    if (!commands.hidden) {
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
  });
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target || target.tagName === 'SELECT') return;

  const action = target.dataset.action;

  if (action === 'submit') { send(); return; }
  if (action === 'complete') { complete(target.dataset.command); return; }
  if (action === 'run') {
    vscode.postMessage({ type: 'submit', text: target.dataset.command });
    return;
  }

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
  });
});

document.addEventListener('change', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target || target.tagName !== 'SELECT') return;
  vscode.postMessage({ type: target.dataset.action, value: target.value, id: target.dataset.id });
});

window.addEventListener('message', (event) => {
  const data = event.data;
  if (!input) return;
  if (data?.type === 'insert') {
    const start = input.selectionStart ?? input.value.length;
    input.value = input.value.slice(0, start) + data.text + input.value.slice(start);
    grow();
    input.focus();
    input.setSelectionRange(start + data.text.length, start + data.text.length);
  }
  if (data?.type === 'focus') input.focus();
});
`;
