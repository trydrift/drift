import * as vscode from 'vscode';
import { join } from 'node:path';
import type { BreakingChange, Evidence, RemediationPlan } from '../../../src/types.js';
import { confidenceDisplay, evidenceStrengthLabel } from '../../../src/report/confidence.js';
import type { DriftState } from '../state.js';
import { highlightCode, languageForEcosystem } from './highlight.js';

/**
 * The Drift report panel.
 *
 * Styled entirely with VS Code's own theme variables, so it looks like part of
 * the editor in any theme — light, dark, or high contrast — rather than a web
 * page someone embedded. No external assets, no fonts, no CDN: a strict CSP
 * blocks everything, which is both a security property and the reason it loads
 * instantly.
 */
export class DriftReportPanel {
  private static current: DriftReportPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  /**
   * Which candidate's plan (if any) this panel is focused on.
   *
   * Set only by an explicit `show()` call, never by the `state.onDidChange`
   * re-render — a state change (a re-analysis finishing, a fresh scan) is not
   * a reason to snap the panel back to the global plan out from under someone
   * looking at a specific package's report.
   */
  private focus: FocusTarget | undefined;

  static show(state: DriftState, focus?: string | FocusTarget): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    const target = typeof focus === 'string' ? { changeId: focus } : focus;

    if (DriftReportPanel.current) {
      DriftReportPanel.current.panel.reveal(column, true);
      DriftReportPanel.current.setFocus(target);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'drift.report',
      'Drift Report',
      { viewColumn: column, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true },
    );

    DriftReportPanel.current = new DriftReportPanel(panel, state);
    DriftReportPanel.current.setFocus(target);
  }

  static refresh(): void {
    DriftReportPanel.current?.render();
  }

  /** Test-only: drop the singleton so tests don't leak a panel into one another. */
  static __resetForTest(): void {
    DriftReportPanel.current?.dispose();
    DriftReportPanel.current = undefined;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly state: DriftState,
  ) {
    this.panel = panel;

    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      state.onDidChange(() => this.render()),
      panel.webview.onDidReceiveMessage((message: IncomingMessage) => this.handle(message)),
    );
  }

  private setFocus(focus: FocusTarget | undefined): void {
    this.focus = focus;
    this.render();
  }

  private async handle(message: IncomingMessage): Promise<void> {
    switch (message.type) {
      case 'openFile': {
        const root = this.state.workspaceRoot;
        if (!root) return;
        const uri = vscode.Uri.file(join(root, message.file));
        await vscode.window.showTextDocument(uri, {
          selection: new vscode.Range(message.line - 1, 0, message.line - 1, 0),
          preview: true,
          viewColumn: vscode.ViewColumn.One,
        });
        return;
      }
      case 'openUrl':
        await vscode.env.openExternal(vscode.Uri.parse(message.url));
        return;
      case 'command':
        await vscode.commands.executeCommand(message.command, ...(message.args ?? []));
        return;
      case 'setting':
        await vscode.workspace
          .getConfiguration('drift')
          .update(message.key, message.value, vscode.ConfigurationTarget.Workspace);
        this.render();
        return;
    }
  }

  private render(): void {
    this.panel.webview.html = renderHtml(this.state, this.panel.webview, this.focus);
  }

  private dispose(): void {
    DriftReportPanel.current = undefined;
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}

type IncomingMessage =
  | { type: 'openFile'; file: string; line: number }
  | { type: 'openUrl'; url: string }
  | { type: 'command'; command: string; args?: unknown[] }
  | { type: 'setting'; key: string; value: unknown };

export interface FocusTarget {
  changeId?: string;
  dependency?: string;
  /**
   * The dependency-scan candidate this report was opened from, when any.
   *
   * `UpgradeCandidate.id` is unique per repo root and workspace member, unlike
   * `dependency` — two candidates can share a package name across workspace
   * members or multiple open repos, and only the id tells them apart. This is
   * what selects *which* plan the panel shows; `dependency` is only used to
   * scroll to and highlight a specific breaking-change card within it.
   */
  candidateId?: string;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function renderHtml(state: DriftState, webview: vscode.Webview, focus?: FocusTarget): string {
  const nonce = makeNonce();
  const plan = resolvePlan(state, focus);

  const body = plan
    ? plan.breakingChanges.length > 0
      ? renderPlan(plan, state, focus)
      : renderCleanPlan(plan, state)
    : renderEmpty(state);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Drift Report</title>
<style>${STYLES}</style>
</head>
<body>
${body}
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}

/**
 * Which plan the panel shows.
 *
 * A candidate opened from the dependency tree carries its own `plan` — the
 * report for that specific package — which can disagree with `state.plan`,
 * the last global analysis. Selecting by `candidateId` rather than by
 * dependency name is what keeps two candidates with the same package name
 * (different workspace members, different open repos) from colliding.
 * Falling back to `state.plan` is what keeps `drift.showReport`'s ordinary,
 * no-argument invocation showing the global analysis it always has.
 */
function resolvePlan(state: DriftState, focus?: FocusTarget): RemediationPlan | null {
  if (focus?.candidateId) {
    const candidate = state.candidates.find((c) => c.id === focus.candidateId);
    if (candidate?.plan) return candidate.plan;
  }
  return state.plan;
}

function renderEmpty(state: DriftState): string {
  const status = state.status;

  if (status.kind === 'analysing') {
    return section(`
      <div class="empty">
        <div class="spinner"></div>
        <h2>Analysing…</h2>
        <p>${escapeHtml(status.detail)}</p>
      </div>`);
  }

  if (status.kind === 'clean') {
    return section(`
      <div class="empty">
        <div class="big-icon ok">✓</div>
        <h2>No breaking changes</h2>
        <p>${escapeHtml(status.summary)}</p>
        <button class="primary" data-command="drift.analyze">Check again</button>
      </div>`);
  }

  if (status.kind === 'error') {
    return section(`
      <div class="empty">
        <div class="big-icon bad">!</div>
        <h2>Analysis failed</h2>
        <p>${escapeHtml(status.message)}</p>
      </div>`);
  }

  return section(`
    <div class="empty">
      <h2>Nothing analysed yet</h2>
      <p>Run <b>Drift: Check for Breaking Changes</b> to get started.</p>
      <button class="primary" data-command="drift.analyze">Check for breaking changes</button>
    </div>`);
}

function renderPlan(plan: RemediationPlan, state: DriftState, focus?: FocusTarget): string {
  const files = new Set(plan.impactSites.map((s) => s.file)).size;
  const status = state.status;
  const pendingUpgrade = isPendingUpgradePlan(plan, state);

  const banner =
    status.kind === 'fixed'
      ? notice(
          'ok',
          `${status.commits} commit(s) on <code>${escapeHtml(status.branch)}</code>`,
          status.warnings.length
            ? `${status.warnings.length} item(s) need your attention — see below.`
            : 'Review the diff, then push when you are ready. Drift never pushes or merges.',
        )
      : status.kind === 'delegated'
        ? notice('info', 'Running on GitHub', escapeHtml(status.message))
        : '';

  const warnings =
    status.kind === 'fixed' && status.warnings.length
      ? section(`
        <h3 class="warn-head">Needs your attention</h3>
        <ul class="warn-list">
          ${status.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}
        </ul>`)
      : '';

  return `
${banner}
<header>
  <h1>Drift</h1>
  <p class="sub">${plan.changes
    .map(
      (c) =>
        `<code>${escapeHtml(c.name)}</code> <span class="tag">${escapeHtml(c.ecosystem)}</span> ${escapeHtml(c.from ?? '—')} → <b>${escapeHtml(c.to ?? '—')}</b>`,
    )
    .join(' · ')}</p>
</header>

${
  // Lead with the verdict for *this* repository. A page that opens with a
  // breaking-change count reads as an alarm even when the answer is "nothing to
  // do", and an alarm that turns out to be nothing gets ignored next time.
  plan.impactSites.length === 0
    ? `<p class="verdict-clear">None of these changes touch code in this repository. Safe to upgrade.</p>`
    : pendingUpgrade
      ? `<p class="verdict-hit">${files} file${files === 1 ? '' : 's'} here would use an API that changes in the selected upgrade.</p>`
      : `<p class="verdict-hit">${files} file${files === 1 ? '' : 's'} here use an API that changed.</p>`
}

<div class="stats">
  ${stat(String(files), 'file' + (files === 1 ? '' : 's') + ' affected here', plan.impactSites.length ? '' : 'risk-none')}
  ${stat(String(plan.impactSites.length), 'code site' + (plan.impactSites.length === 1 ? '' : 's'))}
  ${stat(String(plan.commits.length), 'planned commit' + (plan.commits.length === 1 ? '' : 's'))}
  ${stat(String(plan.breakingChanges.length), 'upstream change' + (plan.breakingChanges.length === 1 ? '' : 's'))}
  ${stat(plan.risk, 'repo risk', riskClass(plan.risk))}
</div>

<div class="actions">
  <button class="primary" data-command="drift.fixAll">Fix with my AI agent</button>
  <button data-command="drift.selectAgent">Change agent</button>
  <button data-command="drift.disableEditorSignals">Hide editor flags</button>
  <button data-command="drift.analyze">Re-analyse</button>
</div>

${plan.blockers.length ? renderBlockers(plan) : ''}
${warnings}
${renderBreakingChanges(plan, focus, pendingUpgrade)}
${renderCommits(plan)}
${renderEvidence(plan)}
`;
}

function renderCleanPlan(plan: RemediationPlan, state: DriftState): string {
  const status = state.status;
  const checked = plan.changes.length;
  const evidenceCount = plan.evidence.length;
  const warnings =
    status.kind === 'clean' && plan.warnings.length
      ? section(`
        <h2>Notes</h2>
        <ul class="warn-list">
          ${plan.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}
        </ul>`)
      : '';

  return `
<header>
  <h1>No breaking changes found</h1>
  <p class="sub">${escapeHtml(status.kind === 'clean' ? status.summary : 'The analysed dependency changes did not produce actionable breakage.')}</p>
</header>

<div class="stats">
  ${stat(String(checked), 'dependency change' + (checked === 1 ? '' : 's'))}
  ${stat(String(evidenceCount), 'evidence record' + (evidenceCount === 1 ? '' : 's'))}
  ${stat('0', 'breaking changes', 'risk-none')}
  ${stat('0', 'planned commits', 'risk-none')}
</div>

<div class="actions">
  <button class="primary" data-command="drift.analyze">Check again</button>
  <button data-command="drift.selectAgent">Choose AI agent</button>
</div>

<section>
  <h2>What Drift Checked</h2>
  <p class="muted">Drift compares dependency versions from git or your working tree, then looks for breaking evidence between those two versions.</p>
  <div class="checked-list">
    ${plan.changes.map(renderCheckedChange).join('')}
  </div>
</section>

<section>
  <h2>Upgrade Candidates</h2>
  <p class="muted">The next useful workflow is a registry scan: compare your installed versions with newer releases, show packages that have breaking evidence, then let you choose which one to localize and fix.</p>
</section>

${warnings}
${renderEvidence(plan)}
`;
}

function renderCheckedChange(change: RemediationPlan['changes'][number]): string {
  return `
<div class="checked-row">
  <div>
    <code>${escapeHtml(change.name)}</code>
    <span class="muted">${escapeHtml(change.ecosystem)} · ${escapeHtml(change.bump)}</span>
  </div>
  <span>${escapeHtml(change.from ?? '—')} → <b>${escapeHtml(change.to ?? '—')}</b></span>
</div>`;
}

function renderBlockers(plan: RemediationPlan): string {
  return section(`
    <h3 class="warn-head">Drift stopped short</h3>
    <ul class="warn-list">
      ${plan.blockers.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}
    </ul>`);
}

function renderBreakingChanges(
  plan: RemediationPlan,
  focus: FocusTarget | undefined,
  pendingUpgrade: boolean,
): string {
  if (plan.breakingChanges.length === 0) return '';

  const found = plan.breakingChanges.filter((change) =>
    plan.impactSites.some((site) => site.breakingChangeId === change.id),
  );
  const notFound = plan.breakingChanges.filter((change) =>
    !plan.impactSites.some((site) => site.breakingChangeId === change.id),
  );

  return `<section>
    <h2>${pendingUpgrade ? 'What would break' : 'What broke'}</h2>
    ${renderChangeGroup('Found in this repo', found, plan, focus, true, pendingUpgrade)}
    ${renderChangeGroup('Not found in this repo', notFound, plan, focus, false, pendingUpgrade)}
  </section>`;
}

function renderChangeGroup(
  title: string,
  changes: readonly BreakingChange[],
  plan: RemediationPlan,
  focus: FocusTarget | undefined,
  open: boolean,
  pendingUpgrade: boolean,
): string {
  if (changes.length === 0) return '';
  const hasFocus = changes.some((change) => isFocusedChange(change, focus));
  return `<details class="change-group" ${open || hasFocus ? 'open' : ''}>
    <summary><span>${escapeHtml(title)}</span><small>${changes.length} breaking change${changes.length === 1 ? '' : 's'}</small></summary>
    ${groupByDependency(changes)
      .map(([dependency, depChanges]) => renderPackageGroup(dependency, depChanges, plan, focus, pendingUpgrade))
      .join('')}
  </details>`;
}

/** Preserves first-seen order, so packages appear in the order Drift found them. */
function groupByDependency(changes: readonly BreakingChange[]): [string, BreakingChange[]][] {
  const byDependency = new Map<string, BreakingChange[]>();
  for (const change of changes) {
    const list = byDependency.get(change.dependency);
    if (list) list.push(change);
    else byDependency.set(change.dependency, [change]);
  }
  return [...byDependency.entries()];
}

function renderPackageGroup(
  dependency: string,
  changes: readonly BreakingChange[],
  plan: RemediationPlan,
  focus: FocusTarget | undefined,
  pendingUpgrade: boolean,
): string {
  const dep = plan.changes.find((c) => c.name === dependency);

  return `<div class="package-group">
    <div class="package-head">
      <code class="dep">${escapeHtml(dependency)}</code>
      ${
        // Which ecosystem this package belongs to. One analysis can span
        // several — an npm dependency and a Go module can both be breaking in
        // the same repository — and `zod` and `zod` from two different
        // registries are two different packages.
        dep ? `<span class="tag">${escapeHtml(dep.ecosystem)}</span>` : ''
      }
      ${dep?.workspace ? `<span class="tag muted-tag" title="Declared in ${escapeAttr(dep.manifestPath)}">${escapeHtml(dep.workspace)}</span>` : ''}
      <span class="muted small">${changes.length} breaking change${changes.length === 1 ? '' : 's'}</span>
      ${renderIssueBranchButton('package', dependency)}
    </div>
    ${changes.map((change) => renderChangeCard(change, plan, isFocusedChange(change, focus), pendingUpgrade)).join('')}
  </div>`;
}

const ISSUE_BRANCH_ACTION_LABEL: Record<'issue' | 'branch' | 'both', string> = {
  issue: 'File issue',
  branch: 'Create branch',
  both: 'Issue + branch',
};

/**
 * The one-click "file this" split button: a primary click runs
 * `issueCreation.default`, and a small caret opens the other two actions —
 * so the common case is one click and every case stays two. `scope`/`id`
 * become `drift.fileBreakingChange`'s first two arguments; the handler
 * looks the finding(s) back up from the current plan, so nothing about a
 * `BreakingChange` needs to round-trip through the webview.
 */
function renderIssueBranchButton(scope: 'change' | 'package', id: string): string {
  const configured = vscode.workspace
    .getConfiguration('drift')
    .get<'issue' | 'branch' | 'both'>('issueCreation.default', 'issue');
  const primary = configured in ISSUE_BRANCH_ACTION_LABEL ? configured : 'issue';
  const others = (['issue', 'branch', 'both'] as const).filter((action) => action !== primary);
  const args = (action: 'issue' | 'branch' | 'both' | null) => escapeAttr(JSON.stringify([scope, id, action]));

  return `<span class="split-action">
    <button class="small" data-command="drift.fileBreakingChange" data-args="${args(null)}">${escapeHtml(ISSUE_BRANCH_ACTION_LABEL[primary])}</button>
    <button class="small caret" data-menu-toggle aria-label="More filing options" title="More filing options">⌄</button>
    <span class="split-menu" hidden>
      ${others
        .map(
          (action) =>
            `<button data-command="drift.fileBreakingChange" data-args="${args(action)}">${escapeHtml(ISSUE_BRANCH_ACTION_LABEL[action])}</button>`,
        )
        .join('')}
    </span>
  </span>`;
}

function renderChangeCard(
  change: BreakingChange,
  plan: RemediationPlan,
  focused: boolean,
  pendingUpgrade: boolean,
): string {
  const sites = plan.impactSites.filter((s) => s.breakingChangeId === change.id);
  const evidence = plan.evidence.filter((e) => change.citations.includes(e.id));
  const diff = changeDiffContext(change, plan);
  // The one number a reader sees first — the three-dimension breakdown in
  // `renderConfidenceDetail` stays underneath for anyone who wants the working.
  const display = confidenceDisplay(change);

  const siteList = sites.length
    ? `<ul class="sites">
        ${sites
          .slice(0, 50)
          .map(
            (s) => `<li>
              <a class="site" data-file="${escapeAttr(s.file)}" data-line="${s.line}">
                <span class="path">${escapeHtml(s.file)}</span><span class="line">:${s.line}</span>
              </a>
              ${s.enclosingSymbol ? `<span class="in">in ${escapeHtml(s.enclosingSymbol)}</span>` : ''}
              <code class="excerpt">${highlightCode(s.excerpt, diff.language)}</code>
            </li>`,
          )
          .join('')}
       </ul>`
    : notSearched(change)
      // "Searched and found nothing" and "could not search" produce the same
      // empty list and mean opposite things. The panel must not render them
      // with the same sentence.
      ? `<p class="muted">Drift did not search this repository for the affected symbols, so this is <b>not</b> evidence the change is unused.</p>`
      : `<p class="muted">Drift searched the files importing this dependency and did not find the affected symbols. No local edit is planned.</p>`;

  const remediation =
    change.remediation.length > 180 || /\n|[-*]\s/.test(change.remediation)
      ? `<details class="fix"><summary>Required fix</summary><div class="markdown">${renderMarkdown(change.remediation, { diff })}</div></details>`
      : `<p class="fix"><b>Required fix:</b> ${inlineMarkdown(change.remediation, {})}</p>`;

  // The declaration itself, before and after — the actual evidence for the
  // summary above. "View diff" is the natural next question a before/after
  // pair raises, answered by opening *this* change in the editor's own diff
  // view (widened to the surrounding published source where that can be
  // fetched) rather than dumping every file that changed in the release.
  const beforeAfter =
    change.before && change.after && change.before !== change.after
      ? renderBeforeAfter(change.before, change.after, {
          title: change.symbols[0] ?? change.dependency,
          ...diff,
        })
      : '';

  return `
<article class="card ${focused ? 'focused' : ''}" id="${escapeAttr(change.id)}" ${focused ? 'data-focus="true"' : ''}>
  <div class="card-head">
    <span class="badge ${display.band}" title="How confident Drift is overall — did this really happen upstream, does it reach this repository, and did anything confirm it">${escapeHtml(display.text)}</span>
    <span class="kind">${escapeHtml(change.kind)}</span>
    <code class="dep">${escapeHtml(change.dependency)}</code>
    ${renderIssueBranchButton('change', change.id)}
  </div>
  ${renderConfidenceDetail(change)}
  <h3>${inlineMarkdown(displaySummary(change, plan, pendingUpgrade), {})}</h3>
  ${beforeAfter}
  ${remediation}
  ${
    evidence.length
      ? `<p class="evidence">Evidence: ${evidence
          .map((e) =>
            e.url
              ? `<a data-url="${escapeAttr(e.url)}">${escapeHtml(e.title)}</a>`
              : `<span>${escapeHtml(e.title)}</span>`,
          )
          .join(' · ')}</p>`
      : ''
  }
  <p class="muted">${escapeHtml(sites.length ? 'Repo risk is based on these local matches.' : 'Repo risk stays none when there are no local matches to edit.')}</p>
  ${siteList}
</article>`;
}

function renderCommits(plan: RemediationPlan): string {
  if (plan.commits.length === 0) return '';
  const branchMode = vscode.workspace.getConfiguration('drift').get<string>('git.branchMode', 'new');
  const commitMode = vscode.workspace.getConfiguration('drift').get<string>('git.commitMode', 'approve');

  return `
<section>
  <h2>Planned commits</h2>
  <p class="muted">One commit per concern, so you can review, approve, or revert each independently.</p>
  <div class="commit-actions">
    <button class="primary" data-command="drift.fixAll">Upgrade and fix all planned commits</button>
    <div class="choice">
      <span>Branch</span>
      <button class="small ${branchMode === 'new' ? 'selected' : ''}" data-setting="git.branchMode" data-value="new">New branch</button>
      <button class="small ${branchMode === 'current' ? 'selected' : ''}" data-setting="git.branchMode" data-value="current">Current branch</button>
    </div>
    <div class="choice">
      <span>Commit</span>
      <button class="small ${commitMode === 'approve' ? 'selected' : ''}" data-setting="git.commitMode" data-value="approve">Review first</button>
      <button class="small ${commitMode === 'auto' ? 'selected' : ''}" data-setting="git.commitMode" data-value="auto">Auto commit</button>
    </div>
  </div>
  <ol class="commits">
    ${plan.commits
      .map(
        (c) => `<li>
          <div class="commit-row">
            <code class="commit-msg">${escapeHtml(c.message)}</code>
            <button class="small" data-command="drift.fixCommit" data-arg="${c.order}">Fix this one</button>
          </div>
          <div class="commit-files">${c.files.map((f) => `<code>${escapeHtml(f)}</code>`).join(' ')}</div>
        </li>`,
      )
      .join('')}
  </ol>
</section>`;
}

function renderEvidence(plan: RemediationPlan): string {
  if (plan.evidence.length === 0) return '';

  return `
<section>
  <h2>Evidence</h2>
  <p class="muted">Every finding above traces back to one of these. Open them to check the work.</p>
  ${plan.evidence.map((evidence) => renderEvidenceItem(evidence, plan)).join('')}
</section>`;
}

function renderEvidenceItem(evidence: Evidence, plan: RemediationPlan): string {
  return `
<details class="evidence-item" id="evidence-${escapeAttr(evidence.id)}">
  <summary>
    <span class="source">${escapeHtml(evidence.source)}</span>
    ${
      evidence.url
        ? `<a data-url="${escapeAttr(evidence.url)}">${escapeHtml(evidence.title)}</a>`
        : `<span>${escapeHtml(evidence.title)}</span>`
    }
    <span class="weight" title="weight ${evidence.weight.toFixed(2)}">${escapeHtml(evidenceStrengthLabel(evidence.weight))}</span>
  </summary>
  <div class="markdown evidence-body">${renderMarkdown(evidence.content, {
    ...(evidence.url ? { baseUrl: evidence.url } : {}),
    // Every before/after inside this record belongs to the same package, so
    // each pair can offer the same "view diff" the findings above do.
    diff: dependencyDiffContext(evidence.dependency, plan),
  })}</div>
</details>`;
}

/* ---------------- small helpers ---------------- */

function section(inner: string): string {
  return `<section>${inner}</section>`;
}

function stat(value: string, label: string, extraClass = ''): string {
  return `<div class="stat ${extraClass}"><div class="value">${escapeHtml(value)}</div><div class="label">${escapeHtml(label)}</div></div>`;
}

function notice(kind: 'ok' | 'info' | 'warn', title: string, detail: string): string {
  return `<div class="notice ${kind}"><b>${title}</b><span>${detail}</span></div>`;
}

function riskClass(risk: string): string {
  return `risk-${risk}`;
}

/**
 * The three dimensions, shown separately, underneath the single overall score.
 *
 * The badge above used to be upstream confidence alone; showing it by itself
 * let a machine-verified upstream diff read as a high-confidence reason to
 * edit local code nothing had shown to be affected. The overall score fixes
 * that at a glance, but the breakdown stays here for anyone who wants to see
 * which of the three questions is actually carrying the number.
 */
function renderConfidenceDetail(change: BreakingChange): string {
  const assessment = change.assessment;
  if (!assessment) return '';

  const taxonomy = change.taxonomy;
  const dimension = (label: string, score: { band: string; score: number }) =>
    `<span class="dim"><span class="dim-label">${label}</span><span class="badge ${score.band}">${score.band}</span></span>`;

  const classification = taxonomy
    ? `<p class="taxonomy">${escapeHtml(taxonomy.nature)} · ${escapeHtml(taxonomy.scope)} · detectable at ${escapeHtml(
        taxonomy.detectability.join(', '),
      )}</p>`
    : '';

  const eligibility = assessment.automaticExecutionEligible
    ? ''
    : `<p class="muted small">Not eligible for automatic execution.</p>`;

  return `<div class="dimensions">
    ${dimension('upstream', assessment.upstream)}
    ${dimension('local impact', assessment.localImpact)}
    ${dimension('verified', assessment.verification)}
  </div>${classification}${eligibility}`;
}

/**
 * What `drift.openFindingDiff` needs to widen a before/after pair into the
 * surrounding published source: which package it came from, at which two
 * versions, and which symbol to look for.
 */
function changeDiffContext(change: BreakingChange, plan: RemediationPlan): DiffContext {
  return {
    ...dependencyDiffContext(change.dependency, plan),
    ...(change.symbols[0] ? { symbol: change.symbols[0] } : {}),
  };
}

function dependencyDiffContext(dependency: string, plan: RemediationPlan): DiffContext {
  const dep = plan.changes.find((c) => c.name === dependency);
  if (!dep?.from || !dep.to) return {};
  return {
    language: languageForEcosystem(dep.ecosystem),
    source: { ecosystem: dep.ecosystem, name: dep.name, from: dep.from, to: dep.to },
  };
}

/**
 * A before/after pair, full width, with the one action it always implies.
 *
 * The button sits in its own header row rather than beside the code: laying
 * them out side by side squeezes the declarations into whatever width the
 * button leaves over, which is exactly where they need the room. `View diff`
 * opens *this* change in the editor's diff view.
 */
function renderBeforeAfter(before: string, after: string, context: DiffContext): string {
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

function renderDiffButton(before: string, after: string, context: DiffContext): string {
  const request = {
    before,
    after,
    title: context.title ?? context.symbol ?? context.source?.name ?? 'change',
    ...(context.language ? { language: context.language } : {}),
    ...(context.symbol ? { symbol: context.symbol } : {}),
    ...(context.source ? { source: context.source } : {}),
  };
  // `data-no-spinner`: this command opens an editor tab, it does not change
  // the plan, so the panel never re-renders — and a spinner with nothing to
  // clear it would sit on the button until its own timeout gave up.
  return `<button class="small" data-no-spinner data-command="drift.openFindingDiff" data-args="${escapeAttr(
    JSON.stringify([request]),
  )}" title="Open just this change in the editor's diff view">View diff</button>`;
}

/** True when localization never ran, as opposed to running and finding nothing. */
function notSearched(change: BreakingChange): boolean {
  return Boolean(
    change.assessment?.localImpact.penalties.some((p) => p.code === 'localization-unavailable'),
  );
}

function displaySummary(change: BreakingChange, plan: RemediationPlan, pendingUpgrade: boolean): string {
  if (!pendingUpgrade) return change.summary;
  const target = plan.changes.find((entry) => entry.name === change.dependency)?.to;
  const version = target ? `${change.dependency}@${target}` : change.dependency;
  return `This breaks in ${version}: ${lowerFirst(change.summary)}`;
}

function lowerFirst(text: string): string {
  return text ? `${text[0]!.toLocaleLowerCase()}${text.slice(1)}` : text;
}

function isFocusedChange(change: BreakingChange, focus: FocusTarget | undefined): boolean {
  return Boolean(
    (focus?.changeId && change.id === focus.changeId) ||
      (focus?.dependency && change.dependency === focus.dependency),
  );
}

function isPendingUpgradePlan(plan: RemediationPlan, state: DriftState): boolean {
  if (state.status.kind !== 'findings') return false;
  return state.candidates.some((candidate) => {
    if (candidate.current === candidate.selected) return false;
    if (candidate.plan?.id === plan.id) return true;
    return plan.changes.some(
      (change) =>
        change.name === candidate.name &&
        change.from === candidate.current &&
        change.to === candidate.selected,
    );
  });
}

/**
 * Where a before/after pair found in prose can be diffed to.
 *
 * Everything is optional because the pair itself is always enough to diff:
 * with a package and a symbol the editor can show the change in its real
 * surroundings, and without them it shows the two declarations, which is still
 * the question the reader asked.
 */
interface DiffContext {
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

function renderMarkdown(text: string, options: MarkdownOptions = {}): string {
  const blocks: string[] = [];
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
        blocks.push(`<pre><code>${highlightCode(code.join('\n'), options.diff?.language)}</code></pre>`);
        code = [];
        inCode = false;
      } else {
        blocks.push(flushPending(), closeList());
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      code.push(raw);
      continue;
    }

    if (!line) {
      blocks.push(flushPending(), closeList());
      continue;
    }

    // A `before:`/`after:` pair is one thing, not two: rendered together, with
    // the button that opens them in the editor's diff view — which is what
    // makes every before/after Drift prints, wherever it prints it, offer the
    // same next step.
    const labelledCode = /^(before|after):\s*(.*)$/i.exec(line);
    if (labelledCode) {
      const label = labelledCode[1]!.toLowerCase();
      const body = labelledCode[2]!;
      if (label === 'before') {
        blocks.push(flushPending(), closeList());
        pendingBefore = body;
        pendingTitle = lastProse;
        continue;
      }
      if (pendingBefore === null) {
        blocks.push(closeList(), codeFigure('after', body, options.diff?.language));
        continue;
      }
      blocks.push(
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

    blocks.push(flushPending());
    lastProse = line.replace(/^[-*]\s+/, '');

    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push(closeList(), `<h3>${inlineMarkdown(heading[2]!, options)}</h3>`);
      continue;
    }

    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      if (!inList) {
        blocks.push('<ul>');
        inList = true;
      }
      blocks.push(`<li>${inlineMarkdown(bullet[1]!, options)}</li>`);
      continue;
    }

    blocks.push(closeList(), `<p>${inlineMarkdown(line, options)}</p>`);
  }

  if (inCode && code.length) {
    blocks.push(`<pre><code>${highlightCode(code.join('\n'), options.diff?.language)}</code></pre>`);
  }
  blocks.push(flushPending(), closeList());
  return blocks.filter(Boolean).join('');
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
    out.push(href ? `<a data-url="${escapeAttr(href)}">${inlineText(label)}</a>` : inlineText(match[0]!));
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
 * itself.
 */
function autolink(html: string): string {
  // `url` is a run of already-escaped HTML, so it is safe in both the
  // attribute and the text without a second pass of escaping (which would
  // turn a query string's `&amp;` into `&amp;amp;`).
  return html.replace(/(<[^>]*>)|(https?:\/\/[^\s<>"')\]]+)/g, (_match, tag: string | undefined, url: string | undefined) =>
    tag ?? `<a data-url="${url}">${url}</a>`,
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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/'/g, '&#39;');
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

const STYLES = `
:root { --gap: 16px; }
* { box-sizing: border-box; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  padding: 20px 24px 60px;
  margin: 0;
  line-height: 1.55;
}
header { margin-bottom: var(--gap); }
h1 { font-size: 1.5rem; margin: 0 0 4px; font-weight: 600; }
h2 { font-size: 1.05rem; margin: 28px 0 10px; font-weight: 600;
     border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 6px; }
h3 { font-size: 0.98rem; margin: 6px 0; font-weight: 600; }
.sub { color: var(--vscode-descriptionForeground); margin: 0; }
.verdict-clear, .verdict-hit {
  margin: 0 0 14px;
  padding: 9px 12px;
  border-radius: 6px;
  border-left: 3px solid var(--vscode-testing-iconPassed);
  background: var(--vscode-editorWidget-background);
  font-size: 14px;
}
.verdict-hit {
  border-left-color: var(--vscode-editorWarning-foreground);
  color: var(--vscode-editorWarning-foreground);
}
.muted { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
code { font-family: var(--vscode-editor-font-family); font-size: 0.9em;
       background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px; }

/* A before/after pair is one block, full width, with its action in a header
   row above it. Laying the button out beside the code instead squeezes the
   declarations into whatever width is left over — which is exactly where the
   room is needed — and leaves the two blocks visibly short of the button's
   right edge. */
.compare { margin: 10px 0; }
.compare-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.compare-label { font-size: 0.72rem; letter-spacing: .04em; text-transform: uppercase;
                 color: var(--vscode-descriptionForeground); }
.compare-head button { margin-left: auto; }

.tag { font-size: 0.7rem; letter-spacing: .03em; padding: 1px 6px; border-radius: 3px;
       background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.tag.muted-tag { background: transparent; color: var(--vscode-descriptionForeground);
                 border: 1px solid var(--vscode-panel-border); }

.stats { display: flex; gap: 10px; flex-wrap: wrap; margin: var(--gap) 0; }
.stat { background: var(--vscode-editorWidget-background);
        border: 1px solid var(--vscode-panel-border); border-radius: 6px;
        padding: 10px 14px; min-width: 92px; }
.stat .value { font-size: 1.35rem; font-weight: 600; }
.stat .label { font-size: 0.78rem; color: var(--vscode-descriptionForeground); text-transform: lowercase; }
.risk-high .value { color: var(--vscode-charts-red); }
.risk-medium .value { color: var(--vscode-charts-yellow); }
.risk-low .value, .risk-none .value { color: var(--vscode-charts-green); }

.actions { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: var(--gap); }
button { font-family: inherit; font-size: 0.9em; padding: 6px 14px; border-radius: 4px;
         border: 1px solid var(--vscode-button-border, transparent); cursor: pointer;
         background: var(--vscode-button-secondaryBackground);
         color: var(--vscode-button-secondaryForeground); }
button:hover { background: var(--vscode-button-secondaryHoverBackground); }
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
button.primary:hover { background: var(--vscode-button-hoverBackground); }
button.small { padding: 3px 10px; font-size: 0.82em; }
button.selected { border-color: var(--vscode-focusBorder); box-shadow: inset 0 0 0 1px var(--vscode-focusBorder); }

.card { border: 1px solid var(--vscode-panel-border); border-left-width: 3px;
        border-radius: 6px; padding: 12px 14px; margin-bottom: 12px;
        background: var(--vscode-editorWidget-background); }
.card.focused { border-color: var(--vscode-focusBorder); }
.card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
.badge { font-size: 0.7rem; text-transform: uppercase; letter-spacing: .05em;
         padding: 2px 7px; border-radius: 10px; font-weight: 600; }
.badge.high { background: var(--vscode-inputValidation-errorBackground);
              color: var(--vscode-errorForeground); }
.badge.medium { background: var(--vscode-inputValidation-warningBackground);
                color: var(--vscode-editorWarning-foreground); }
.badge.low { background: var(--vscode-inputValidation-infoBackground);
             color: var(--vscode-editorInfo-foreground); }
.badge.none { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.kind { font-size: 0.78rem; color: var(--vscode-descriptionForeground); }
.dep { margin-left: auto; }
.fix { margin: 8px 0; }
.fix summary { cursor: pointer; color: var(--vscode-textLink-foreground); }
.evidence { font-size: 0.88em; margin: 6px 0; }

a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
a:hover { text-decoration: underline; color: var(--vscode-textLink-activeForeground); }

.sites { list-style: none; padding: 0; margin: 10px 0 0; }
.sites li { padding: 4px 0; border-top: 1px solid var(--vscode-panel-border);
            display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.site .path { color: var(--vscode-textLink-foreground); }
.site .line { color: var(--vscode-descriptionForeground); }
.in { font-size: 0.82em; color: var(--vscode-descriptionForeground); }
.excerpt { flex: 1 1 260px; min-width: 0; opacity: .85; overflow-x: auto; white-space: pre; }

.change-group { border: 1px solid var(--vscode-panel-border); border-radius: 6px; margin-bottom: 12px; overflow: hidden; }
.change-group > summary {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 12px;
  cursor: pointer;
  font-weight: 600;
}
.change-group[open] > summary { border-bottom: 1px solid var(--vscode-panel-border); }
.change-group summary small { color: var(--vscode-descriptionForeground); font-weight: 400; }
.change-group .card { border-width: 0 0 1px 3px; border-radius: 0; margin: 0; }
.change-group .card:last-child { border-bottom: 0; }

.package-group + .package-group { border-top: 1px solid var(--vscode-panel-border); }
.package-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px;
                background: var(--vscode-editorWidget-background); flex-wrap: wrap; }
.package-head .dep { font-weight: 600; }
.package-head .split-action { margin-left: auto; }

.split-action { position: relative; display: inline-flex; }
.split-action button.small { border-radius: 0; }
.split-action button.small:first-child { border-radius: 3px 0 0 3px; }
.split-action button.caret { border-radius: 0 3px 3px 0; border-left: none; padding: 3px 6px; }
.split-menu { position: absolute; top: 100%; right: 0; z-index: 10; margin-top: 2px;
              display: flex; flex-direction: column; min-width: 140px;
              background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border);
              border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,.25); overflow: hidden; }
.split-menu[hidden] { display: none; }
.split-menu button { border: none; border-radius: 0; background: transparent; text-align: left;
                      padding: 6px 10px; font-size: 0.82em; color: var(--vscode-dropdown-foreground); }
.split-menu button:hover { background: var(--vscode-list-hoverBackground); }

.commits { padding-left: 20px; }
.commits li { margin-bottom: 10px; }
.commit-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 8px 0 12px; }
.choice { display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.choice span { color: var(--vscode-descriptionForeground); font-size: 0.82em; margin-right: 2px; }
.commit-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.commit-msg { flex: 1 1 auto; }
.commit-files { margin-top: 4px; font-size: 0.82em; opacity: .75; }

.checked-list { border: 1px solid var(--vscode-panel-border); border-radius: 6px; overflow: hidden; }
.checked-row { display: flex; align-items: center; justify-content: space-between; gap: 12px;
               padding: 9px 12px; border-top: 1px solid var(--vscode-panel-border); }
.checked-row:first-child { border-top: 0; }
.checked-row > div { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; min-width: 0; }
.checked-row > span { white-space: nowrap; color: var(--vscode-descriptionForeground); }

.evidence-item { border: 1px solid var(--vscode-panel-border); border-radius: 5px;
                 padding: 8px 10px; margin-bottom: 8px; }
.evidence-item summary { cursor: pointer; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.source { font-size: 0.72rem; text-transform: uppercase; letter-spacing: .04em;
          background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
          padding: 2px 6px; border-radius: 3px; }
.weight { margin-left: auto; font-size: 0.78em; color: var(--vscode-descriptionForeground); }
/* Code keeps its own lines and scrolls sideways, the way the editor does.
   Wrapping a declaration mid-signature (the old \`pre-wrap\` + \`break-word\`)
   re-flows it into something that is no longer the code being quoted, and a
   block with no horizontal scroll is simply cropped. */
pre { background: var(--vscode-textCodeBlock-background); padding: 10px; border-radius: 4px;
      overflow-x: auto; overflow-y: hidden; max-width: 100%;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size, 0.85em);
      line-height: 1.5; white-space: pre; word-break: normal; margin: 8px 0 0; }
pre code { background: none; padding: 0; font-size: inherit; }
.code-compare { margin: 8px 0; min-width: 0; }
.code-compare figcaption {
  color: var(--vscode-descriptionForeground);
  font-size: 0.72rem;
  letter-spacing: .04em;
  margin-bottom: 4px;
  text-transform: uppercase;
}
.code-compare pre { margin-top: 0; }
.markdown {
  background: transparent;
  max-height: 260px;
  overflow: auto;
}
.markdown p { margin: 0 0 7px; }
.markdown p:last-child { margin-bottom: 0; }
.markdown ul { margin: 6px 0 8px; padding-left: 20px; }
.markdown h3 { margin: 10px 0 4px; }
.evidence-body {
  background: var(--vscode-textCodeBlock-background);
  padding: 10px;
  border-radius: 4px;
  margin-top: 8px;
}

.notice { display: flex; flex-direction: column; gap: 2px; padding: 10px 14px;
          border-radius: 5px; margin-bottom: var(--gap); border-left: 3px solid; }
.notice.ok { background: var(--vscode-editorWidget-background); border-color: var(--vscode-charts-green); }
.notice.info { background: var(--vscode-editorWidget-background); border-color: var(--vscode-charts-blue); }
.notice.warn { background: var(--vscode-inputValidation-warningBackground);
               border-color: var(--vscode-editorWarning-foreground); }

.warn-head { color: var(--vscode-editorWarning-foreground); }
.warn-list { margin: 6px 0; padding-left: 20px; }
.warn-list li { margin-bottom: 4px; }

.empty { text-align: center; padding: 60px 20px; }
.big-icon { font-size: 2.4rem; line-height: 1; margin-bottom: 10px; }
.big-icon.ok { color: var(--vscode-charts-green); }
.big-icon.bad { color: var(--vscode-charts-red); }
/* A soft fading ring rather than a hard two-tone border — the border trick
   reads as two flat arcs (one grey, one accent) chasing each other, which at
   a glance looks like a stray line spinning rather than a loading indicator.
   A conic gradient masked down to a ring fades smoothly around its own
   circumference instead, the same shape VS Code's own spinners use. */
.spinner {
  width: 26px; height: 26px; margin: 0 auto 14px; border-radius: 50%;
  background: conic-gradient(from 0turn, transparent, transparent 65%, var(--vscode-progressBar-background));
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2.4px), #000 calc(100% - 2.4px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 2.4px), #000 calc(100% - 2.4px));
  animation: spin 0.9s linear infinite;
}
@keyframes spin { to { transform: rotate(1turn); } }

/* A click on a command button (file an issue, create a branch, install an
   upgrade) round-trips through \`gh\`/git and can take a few seconds — this
   panel re-renders by replacing the whole document when the extension host
   answers, so nothing needs to reset the class below by hand. Without it, a
   click that visibly does nothing is what makes someone click twice. */
[data-command].is-loading {
  position: relative;
  color: transparent !important;
  pointer-events: none;
}
[data-command].is-loading::after {
  content: '';
  position: absolute;
  inset: 0;
  margin: auto;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: conic-gradient(from 0turn, transparent, transparent 65%, var(--vscode-progressBar-background));
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 1.6px), #000 calc(100% - 1.6px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 1.6px), #000 calc(100% - 1.6px));
  animation: spin .8s linear infinite;
}
`;

const SCRIPT = `
const vscode = acquireVsCodeApi();
function closeMenus() {
  document.querySelectorAll('.split-menu').forEach((menu) => { menu.hidden = true; });
}
document.addEventListener('click', (event) => {
  const toggle = event.target.closest('[data-menu-toggle]');
  if (toggle) {
    const menu = toggle.nextElementSibling;
    const wasOpen = menu && !menu.hidden;
    closeMenus();
    if (menu) menu.hidden = wasOpen;
    event.stopPropagation();
    return;
  }
  const insideMenu = event.target.closest('.split-menu');
  if (!insideMenu) closeMenus();

  const site = event.target.closest('[data-file]');
  if (site) {
    vscode.postMessage({ type: 'openFile', file: site.dataset.file, line: Number(site.dataset.line) });
    return;
  }
  const link = event.target.closest('[data-url]');
  if (link) {
    vscode.postMessage({ type: 'openUrl', url: link.dataset.url });
    return;
  }
  const button = event.target.closest('[data-command]');
  if (button) {
    if (button.classList.contains('is-loading')) return;
    const spins = button.dataset.noSpinner === undefined;
    let args = [];
    if (button.dataset.args !== undefined) {
      try { args = JSON.parse(button.dataset.args); } catch { args = []; }
    } else if (button.dataset.arg !== undefined) {
      args = [Number(button.dataset.arg)];
    }
    if (spins) {
      button.classList.add('is-loading');
      // The panel re-renders by replacing the whole document once the host
      // answers; if that answer never comes (a bug, a crashed command), the
      // spinner should give up rather than sit dead forever.
      setTimeout(() => button.classList.remove('is-loading'), 20000);
    }
    vscode.postMessage({
      type: 'command',
      command: button.dataset.command,
      args,
    });
    return;
  }
  const setting = event.target.closest('[data-setting]');
  if (setting) {
    vscode.postMessage({
      type: 'setting',
      key: setting.dataset.setting,
      value: setting.dataset.value,
    });
  }
});
const focused = document.querySelector('[data-focus="true"]');
if (focused) {
  requestAnimationFrame(() => focused.scrollIntoView({ block: 'center' }));
}
`;

/**
 * Test-only entry point.
 *
 * Lets the headless harness exercise the real renderer without constructing a
 * webview panel, so the report's markup and styling are covered by tests
 * rather than only by eye.
 */
export function __renderForTest(state: DriftState, focus?: string | { changeId?: string; dependency?: string; candidateId?: string }): string {
  const fakeWebview = { cspSource: 'vscode-webview://test' } as unknown as vscode.Webview;
  const target = typeof focus === 'string' ? { changeId: focus } : focus;
  return renderHtml(state, fakeWebview, target);
}
