import * as vscode from 'vscode';
import { join } from 'node:path';
import type { BreakingChange, Evidence, RemediationPlan } from '../../../src/types.js';
import type { DriftState } from '../state.js';

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

  static show(state: DriftState, focusChangeId?: string): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (DriftReportPanel.current) {
      DriftReportPanel.current.panel.reveal(column, true);
      DriftReportPanel.current.render(focusChangeId);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'drift.report',
      'Drift Report',
      { viewColumn: column, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true },
    );

    DriftReportPanel.current = new DriftReportPanel(panel, state);
    DriftReportPanel.current.render(focusChangeId);
  }

  static refresh(): void {
    DriftReportPanel.current?.render();
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
    }
  }

  private render(focusChangeId?: string): void {
    this.panel.webview.html = renderHtml(this.state, this.panel.webview, focusChangeId);
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
  | { type: 'command'; command: string; args?: unknown[] };

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function renderHtml(state: DriftState, webview: vscode.Webview, focusChangeId?: string): string {
  const nonce = makeNonce();
  const plan = state.plan;

  const body = plan
    ? plan.breakingChanges.length > 0
      ? renderPlan(plan, state, focusChangeId)
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

function renderPlan(plan: RemediationPlan, state: DriftState, focusChangeId?: string): string {
  const files = new Set(plan.impactSites.map((s) => s.file)).size;
  const status = state.status;

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
        `<code>${escapeHtml(c.name)}</code> ${escapeHtml(c.from ?? '—')} → <b>${escapeHtml(c.to ?? '—')}</b>`,
    )
    .join(' · ')}</p>
</header>

<div class="stats">
  ${stat(String(plan.breakingChanges.length), 'breaking change' + (plan.breakingChanges.length === 1 ? '' : 's'))}
  ${stat(String(plan.impactSites.length), 'repo match' + (plan.impactSites.length === 1 ? '' : 'es'))}
  ${stat(String(files), 'file' + (files === 1 ? '' : 's'))}
  ${stat(String(plan.commits.length), 'commit' + (plan.commits.length === 1 ? '' : 's'))}
  ${stat(plan.risk, 'repo risk', riskClass(plan.risk))}
</div>

<div class="actions">
  <button class="primary" data-command="drift.fixAll">Fix with my AI agent</button>
  <button data-command="drift.selectAgent">Change agent</button>
  <button data-command="drift.analyze">Re-analyse</button>
</div>

${plan.blockers.length ? renderBlockers(plan) : ''}
${warnings}
${renderBreakingChanges(plan, focusChangeId)}
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

function renderBreakingChanges(plan: RemediationPlan, focusChangeId?: string): string {
  if (plan.breakingChanges.length === 0) return '';

  const found = plan.breakingChanges.filter((change) =>
    plan.impactSites.some((site) => site.breakingChangeId === change.id),
  );
  const notFound = plan.breakingChanges.filter((change) =>
    !plan.impactSites.some((site) => site.breakingChangeId === change.id),
  );

  return `<section>
    <h2>What broke</h2>
    ${renderChangeGroup('Found in this repo', found, plan, focusChangeId, true)}
    ${renderChangeGroup('Not found in this repo', notFound, plan, focusChangeId, false)}
  </section>`;
}

function renderChangeGroup(
  title: string,
  changes: readonly BreakingChange[],
  plan: RemediationPlan,
  focusChangeId: string | undefined,
  open: boolean,
): string {
  if (changes.length === 0) return '';
  return `<details class="change-group" ${open ? 'open' : ''}>
    <summary><span>${escapeHtml(title)}</span><small>${changes.length} breaking change${changes.length === 1 ? '' : 's'}</small></summary>
    ${changes.map((change) => renderChangeCard(change, plan, change.id === focusChangeId)).join('')}
  </details>`;
}

function renderChangeCard(
  change: BreakingChange,
  plan: RemediationPlan,
  focused: boolean,
): string {
  const sites = plan.impactSites.filter((s) => s.breakingChangeId === change.id);
  const evidence = plan.evidence.filter((e) => change.citations.includes(e.id));

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
              <code class="excerpt">${escapeHtml(s.excerpt)}</code>
            </li>`,
          )
          .join('')}
       </ul>`
    : `<p class="muted">Drift found this upstream breaking change, but did not find the affected symbols in this repository. No local edit is planned.</p>`;

  const remediation =
    change.remediation.length > 180 || /\n|[-*]\s/.test(change.remediation)
      ? `<details class="fix"><summary>Required fix</summary><div class="markdown">${renderMarkdown(change.remediation)}</div></details>`
      : `<p class="fix"><b>Required fix:</b> ${escapeHtml(change.remediation)}</p>`;

  return `
<article class="card ${focused ? 'focused' : ''}" id="${escapeAttr(change.id)}">
  <div class="card-head">
    <span class="badge ${change.confidence}">${change.confidence}</span>
    <span class="kind">${escapeHtml(change.kind)}</span>
    <code class="dep">${escapeHtml(change.dependency)}</code>
  </div>
  <h3>${escapeHtml(change.summary)}</h3>
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

  return `
<section>
  <h2>Planned commits</h2>
  <p class="muted">One commit per concern, so you can review, approve, or revert each independently.</p>
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
  ${plan.evidence.map(renderEvidenceItem).join('')}
</section>`;
}

function renderEvidenceItem(evidence: Evidence): string {
  return `
<details class="evidence-item">
  <summary>
    <span class="source">${escapeHtml(evidence.source)}</span>
    ${
      evidence.url
        ? `<a data-url="${escapeAttr(evidence.url)}">${escapeHtml(evidence.title)}</a>`
        : `<span>${escapeHtml(evidence.title)}</span>`
    }
    <span class="weight">weight ${evidence.weight.toFixed(2)}</span>
  </summary>
  <div class="markdown evidence-body">${renderMarkdown(evidence.content.slice(0, 4000))}</div>
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

function renderMarkdown(text: string): string {
  const escaped = escapeHtml(text);
  const blocks: string[] = [];
  let inList = false;

  const closeList = () => {
    if (!inList) return '';
    inList = false;
    return '</ul>';
  };

  for (const raw of escaped.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      blocks.push(closeList());
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push(closeList(), `<h3>${inlineMarkdown(heading[2]!)}</h3>`);
      continue;
    }

    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      if (!inList) {
        blocks.push('<ul>');
        inList = true;
      }
      blocks.push(`<li>${inlineMarkdown(bullet[1]!)}</li>`);
      continue;
    }

    blocks.push(closeList(), `<p>${inlineMarkdown(line)}</p>`);
  }

  blocks.push(closeList());
  return blocks.filter(Boolean).join('');
}

function inlineMarkdown(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_match, label: string, url: string) => {
      return `<a data-url="${escapeAttr(url)}">${label}</a>`;
    });
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
.muted { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
code { font-family: var(--vscode-editor-font-family); font-size: 0.9em;
       background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px; }

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
.excerpt { flex: 1 1 260px; opacity: .85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

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

.commits { padding-left: 20px; }
.commits li { margin-bottom: 10px; }
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
pre { background: var(--vscode-textCodeBlock-background); padding: 10px; border-radius: 4px;
      overflow-x: auto; font-family: var(--vscode-editor-font-family); font-size: 0.85em;
      white-space: pre-wrap; word-break: break-word; margin: 8px 0 0; }
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
.spinner { width: 26px; height: 26px; margin: 0 auto 14px;
           border: 2px solid var(--vscode-panel-border);
           border-top-color: var(--vscode-progressBar-background);
           border-radius: 50%; animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
`;

const SCRIPT = `
const vscode = acquireVsCodeApi();
document.addEventListener('click', (event) => {
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
    const arg = button.dataset.arg;
    vscode.postMessage({
      type: 'command',
      command: button.dataset.command,
      args: arg === undefined ? [] : [Number(arg)],
    });
  }
});
`;

/**
 * Test-only entry point.
 *
 * Lets the headless harness exercise the real renderer without constructing a
 * webview panel, so the report's markup and styling are covered by tests
 * rather than only by eye.
 */
export function __renderForTest(state: DriftState): string {
  const fakeWebview = { cspSource: 'vscode-webview://test' } as unknown as vscode.Webview;
  return renderHtml(state, fakeWebview);
}
