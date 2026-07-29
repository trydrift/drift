import * as vscode from 'vscode';
import { join, relative } from 'node:path';
import type { BreakingChange, Evidence, RemediationPlan, RepoContext } from '../../../src/types.js';
import { buildPlan } from '../../../src/plan/index.js';
import { inspectLocalRepo } from '../../../src/repo/local-git.js';
import { DriftConfigSchema, type DriftConfig } from '../../../src/config/schema.js';
import { loadWorkspaceConfig, runAnalysis } from '../analyze.js';
import { runFix } from '../fix.js';
import type { DriftState } from '../state.js';
import { discoverAgents, invalidateAgentCache, type DiscoveredAgent } from '../agents/registry.js';
import { getGitHubSession, getRateLimitToken } from '../github-auth.js';
import {
  installNpmForcedUpgrade,
  installNpmUpgrade,
  reanalyzeUpgrade,
  scanNpmUpgrades,
  type UpgradeCandidate,
} from '../upgrades.js';
import { DriftReportPanel } from './report.js';

type Message =
  | { role: 'drift'; text: string }
  | { role: 'user'; text: string }
  | { role: 'agent'; text: string };

type Incoming =
  | { type: 'scanUpgrades' }
  | { type: 'analyzeRecent' }
  | { type: 'selectVersion'; id: string; version: string }
  | { type: 'toggleCandidate'; id: string; selected: boolean }
  | { type: 'upgradeCandidate'; id: string; mode?: UpgradeMode; fix?: boolean }
  | { type: 'upgradeSelected'; mode?: UpgradeMode; fix?: boolean }
  | { type: 'fixCandidate'; id: string }
  | { type: 'fixSelected' }
  | { type: 'openFile'; file: string; line: number }
  | { type: 'openUrl'; url: string }
  | { type: 'showReport' }
  | { type: 'selectAgent' }
  | { type: 'setAgent'; id: string }
  | { type: 'signIn' }
  | { type: 'pickFile' }
  | { type: 'pickFolder' }
  | { type: 'sendMessage'; text: string };

type UpgradeMode = 'safe' | 'force';

/**
 * The main Drift column.
 *
 * A `WebviewView` is still native VS Code UI: it lives in the activity-bar
 * column, uses theme tokens, and behaves like Copilot/Claude-style side panels.
 * The tree remains useful for simple hierarchies, but dropdowns, real buttons,
 * agent chips, and a chat/progress thread need a richer view surface.
 */
export class DriftHomeView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private candidates: UpgradeCandidate[] = [];
  private selected = new Set<string>();
  private agents: DiscoveredAgent[] = [];
  private signedInLabel: string | null = null;
  private scanStatus: 'idle' | 'scanning' | 'ready' | 'error' = 'idle';
  private scanSummary = 'Scan installed npm packages for available upgrades.';
  private messages: Message[] = [
    {
      role: 'drift',
      text: 'Pick one package or select several. Drift will inspect breaking evidence before any AI fix runs.',
    },
  ];
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly state: DriftState,
  ) {
    this.disposables.push(
      state.onDidChange(() => this.render()),
      vscode.authentication.onDidChangeSessions((event) => {
        if (event.provider.id === 'github') void this.refreshIdentity();
      }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    this.disposables.push(view.webview.onDidReceiveMessage((message: Incoming) => this.handle(message)));
    void this.refreshIdentity();
    void this.refreshAgents();
    void this.scanUpgrades();
    this.render();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  private async handle(message: Incoming): Promise<void> {
    switch (message.type) {
      case 'scanUpgrades':
        await this.scanUpgrades(true);
        return;
      case 'analyzeRecent':
        await this.analyzeRecent();
        return;
      case 'selectVersion':
        await this.selectVersion(message.id, message.version);
        return;
      case 'toggleCandidate':
        if (message.selected) this.selected.add(message.id);
        else this.selected.delete(message.id);
        this.render();
        return;
      case 'upgradeCandidate':
        await this.upgradeCandidates([message.id], message.mode ?? 'safe', Boolean(message.fix));
        return;
      case 'upgradeSelected':
        await this.upgradeCandidates([...this.selected], message.mode ?? 'safe', Boolean(message.fix));
        return;
      case 'fixCandidate':
        await this.fixCandidates([message.id]);
        return;
      case 'fixSelected':
        await this.fixCandidates([...this.selected]);
        return;
      case 'showReport':
        DriftReportPanel.show(this.state);
        return;
      case 'openFile':
        await this.openFile(message.file, message.line);
        return;
      case 'openUrl':
        await vscode.env.openExternal(vscode.Uri.parse(message.url));
        return;
      case 'selectAgent':
        await vscode.commands.executeCommand('drift.selectAgent');
        invalidateAgentCache();
        await this.refreshAgents();
        return;
      case 'setAgent':
        await this.setAgent(message.id);
        return;
      case 'signIn':
        await getGitHubSession({ createIfNone: true });
        await this.refreshIdentity();
        await this.refreshAgents();
        return;
      case 'pickFile':
        await this.pickMention('file');
        return;
      case 'pickFolder':
        await this.pickMention('folder');
        return;
      case 'sendMessage':
        await this.addChatInstruction(message.text);
        return;
    }
  }

  private async scanUpgrades(force = false): Promise<void> {
    if (this.scanStatus === 'scanning') return;
    if (!force && this.candidates.length > 0) return;

    const ctx = await this.context();
    if (!ctx) {
      this.scanStatus = 'error';
      this.scanSummary = 'Open a git repository with package.json to scan upgrades.';
      this.render();
      return;
    }

    this.scanStatus = 'scanning';
    this.scanSummary = 'Checking npm registry and Drift evidence...';
    this.render();

    try {
      const result = await scanNpmUpgrades({
        root: ctx.root,
        repo: ctx.repo,
        config: ctx.config,
        githubToken: await getRateLimitToken(),
        onProgress: (detail) => {
          this.scanSummary = detail;
          this.render();
        },
      });
      this.candidates = result.candidates;
      this.selected = new Set(result.candidates.filter((c) => c.breakingCount > 0).map((c) => c.id));
      this.scanStatus = 'ready';
      this.scanSummary =
        result.candidates.length > 0
          ? `${result.candidates.length} upgrade candidate${result.candidates.length === 1 ? '' : 's'} found from ${result.checked} package${result.checked === 1 ? '' : 's'}.`
          : `No newer npm versions found across ${result.checked} package${result.checked === 1 ? '' : 's'}.`;
      this.messages.unshift({
        role: 'drift',
        text: this.scanSummary,
      });
    } catch (err) {
      this.scanStatus = 'error';
      this.scanSummary = (err as Error).message;
      this.messages.unshift({ role: 'drift', text: `Upgrade scan failed: ${this.scanSummary}` });
    }

    this.render();
  }

  private async analyzeRecent(): Promise<void> {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Drift: checking recent dependency changes' },
      (progress, token) => runAnalysis({ state: this.state, progress, token }),
    );
    this.messages.unshift({ role: 'drift', text: result.summary });
    this.render();
  }

  private async selectVersion(id: string, version: string): Promise<void> {
    const ctx = await this.context();
    const candidate = this.candidates.find((c) => c.id === id);
    if (!ctx || !candidate) return;

    this.replaceCandidate({ ...candidate, selected: version, status: 'checking', summary: 'Rechecking evidence...' });
    this.render();

    const updated = await reanalyzeUpgrade({
      candidate,
      version,
      root: ctx.root,
      repo: ctx.repo,
      config: ctx.config,
      githubToken: await getRateLimitToken(),
    });
    this.replaceCandidate(updated);
    if (this.selected.delete(id) || updated.breakingCount > 0) this.selected.add(updated.id);
    this.render();
  }

  private async upgradeCandidates(ids: string[], mode: UpgradeMode, fix: boolean): Promise<void> {
    const ctx = await this.context();
    const candidates = this.candidates.filter((c) => ids.includes(c.id));
    if (!ctx || candidates.length === 0) {
      this.messages.unshift({ role: 'drift', text: 'Select at least one upgrade candidate first.' });
      this.render();
      return;
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Drift: upgrading dependencies' },
      async (progress) => {
        const nextIds: string[] = [];
        for (const candidate of candidates) {
          const target =
            mode === 'force' ? candidate.latest : (candidate.safeLatest ?? candidate.selected);
          let updatedCandidate = { ...candidate, selected: target };

          if (target !== candidate.selected) {
            progress.report({ message: `Checking ${candidate.name}@${target}` });
            this.replaceCandidate({ ...updatedCandidate, status: 'checking', summary: 'Rechecking evidence...' });
            this.render();
            updatedCandidate = await reanalyzeUpgrade({
              candidate,
              version: target,
              root: ctx.root,
              repo: ctx.repo,
              config: ctx.config,
              githubToken: await getRateLimitToken(),
            });
          }

          progress.report({ message: `${candidate.name}@${target}` });
          this.replaceCandidate({ ...updatedCandidate, status: 'upgrading', summary: 'Updating package files...' });
          this.render();
          if (mode === 'force') await installNpmForcedUpgrade(ctx.root, updatedCandidate);
          else await installNpmUpgrade(ctx.root, updatedCandidate);
          this.replaceCandidate({ ...updatedCandidate, status: 'ready', summary: 'Dependency files updated.' });
          this.messages.unshift({
            role: 'drift',
            text:
              mode === 'force'
                ? `Forced ${candidate.name} to ${target} with npm --force. Review dependency conflicts before committing.`
                : `Safely updated ${candidate.name} to ${target} within the compatible npm range.`,
          });
          nextIds.push(updatedCandidate.id);
        }
        ids.splice(0, ids.length, ...nextIds);
      },
    );

    this.render();
    if (fix) await this.fixCandidates(ids);
  }

  private async fixCandidates(ids: string[]): Promise<void> {
    const ctx = await this.context();
    const candidates = this.candidates.filter((c) => ids.includes(c.id) && c.plan);
    if (!ctx || candidates.length === 0) {
      this.messages.unshift({ role: 'drift', text: 'Select a candidate with breaking-change analysis first.' });
      this.render();
      return;
    }

    const plan = combinePlans(ctx.repo, ctx.config, candidates.map((c) => c.plan!));
    if (plan.commits.length === 0) {
      this.messages.unshift({
        role: 'drift',
        text: 'No repo matches were found, so there is nothing for an AI agent to edit.',
      });
      this.render();
      return;
    }

    this.state.set({ kind: 'findings', plan, at: Date.now() });
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Drift: fixing selected upgrades', cancellable: true },
      (progress, token) => runFix({ state: this.state, plan, progress, token }),
    );
    this.messages.unshift({
      role: result.status === 'failed' ? 'drift' : 'agent',
      text: result.message,
    });
    for (const warning of result.warnings) this.messages.unshift({ role: 'drift', text: warning });
    this.render();
  }

  private async addChatInstruction(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.messages.unshift({ role: 'user', text: trimmed });

    const config = vscode.workspace.getConfiguration('drift');
    const current = config.get<string>('fix.customInstructions', '').trim();
    const next = [current, trimmed].filter(Boolean).join('\n');
    await config.update('fix.customInstructions', next, vscode.ConfigurationTarget.Workspace);

    this.messages.unshift({
      role: 'agent',
      text: "Got it. I added that to this workspace's Drift instructions for the next upgrade fix.",
    });
    this.render();
  }

  private async setAgent(id: string): Promise<void> {
    await vscode.workspace
      .getConfiguration('drift')
      .update('agent.preferred', id, vscode.ConfigurationTarget.Global);
    invalidateAgentCache();
    await this.refreshAgents();
    const picked =
      id === 'auto' ? 'Automatic' : this.agents.find((entry) => entry.agent.id === id)?.agent.label ?? id;
    this.messages.unshift({ role: 'drift', text: `AI agent set to ${picked}.` });
    this.render();
  }

  private async pickMention(kind: 'file' | 'folder'): Promise<void> {
    const ctx = await this.context();
    if (!ctx || !this.view) return;

    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: kind === 'file',
      canSelectFolders: kind === 'folder',
      canSelectMany: false,
      defaultUri: vscode.Uri.file(ctx.root),
      openLabel: kind === 'file' ? 'Mention File' : 'Mention Folder',
    });
    const uri = picked?.[0];
    if (!uri) return;

    const rel = relative(ctx.root, uri.fsPath).replace(/\\/g, '/');
    await this.view.webview.postMessage({ type: 'insertText', text: `@${rel || '.'} ` });
  }

  private async openFile(file: string, line: number): Promise<void> {
    const ctx = await this.context();
    if (!ctx) return;
    await vscode.window.showTextDocument(vscode.Uri.file(join(ctx.root, file)), {
      selection: new vscode.Range(Math.max(0, line - 1), 0, Math.max(0, line - 1), 0),
      preview: true,
      viewColumn: vscode.ViewColumn.One,
    });
  }

  private async refreshIdentity(): Promise<void> {
    const session = await getGitHubSession({ createIfNone: false });
    this.signedInLabel = session?.account.label ?? null;
    this.render();
  }

  private async refreshAgents(): Promise<void> {
    const ctx = await this.context();
    if (!ctx) {
      this.agents = [];
      this.render();
      return;
    }
    this.agents = await discoverAgents({ slug: ctx.info.slug, baseBranch: ctx.info.branch }, { force: true });
    this.render();
  }

  private async context(): Promise<{
    root: string;
    info: NonNullable<Awaited<ReturnType<typeof inspectLocalRepo>>>;
    repo: RepoContext;
    config: DriftConfig;
  } | null> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return null;

    const root = folder.uri.fsPath;
    const info = await inspectLocalRepo(root);
    if (!info) return null;

    const config = await loadWorkspaceConfig(root).catch(() => DriftConfigSchema.parse({}));
    const repo: RepoContext = {
      owner: info.slug?.split('/')[0] ?? 'local',
      repo: info.slug?.split('/')[1] ?? 'workspace',
      baseBranch: info.branch,
      beforeSha: info.parentSha ?? info.headSha,
      afterSha: info.headSha,
      workspace: root,
    };

    return { root, info, repo, config };
  }

  private replaceCandidate(candidate: UpgradeCandidate): void {
    const index = this.candidates.findIndex((c) => c.name === candidate.name);
    if (index === -1) this.candidates.push(candidate);
    else this.candidates[index] = candidate;
  }

  private render(): void {
    if (!this.view) return;
    const nonce = makeNonce();
    this.view.webview.html = renderHtml({
      nonce,
      status: this.state.status.kind,
      signedInLabel: this.signedInLabel,
      currentAgent: vscode.workspace.getConfiguration('drift').get<string>('agent.preferred', 'auto'),
      agents: this.agents,
      candidates: this.candidates,
      selected: this.selected,
      scanStatus: this.scanStatus,
      scanSummary: this.scanSummary,
      messages: this.messages,
    });
  }
}

function combinePlans(repo: RepoContext, config: DriftConfig, plans: RemediationPlan[]): RemediationPlan {
  return buildPlan({
    repo,
    config,
    changes: plans.flatMap((p) => p.changes),
    evidence: plans.flatMap((p) => p.evidence),
    breakingChanges: plans.flatMap((p) => p.breakingChanges),
    impactSites: plans.flatMap((p) => p.impactSites),
  });
}

function renderHtml(input: {
  nonce: string;
  status: string;
  signedInLabel: string | null;
  currentAgent: string;
  agents: DiscoveredAgent[];
  candidates: UpgradeCandidate[];
  selected: Set<string>;
  scanStatus: 'idle' | 'scanning' | 'ready' | 'error';
  scanSummary: string;
  messages: Message[];
}): string {
  const availableAgents = input.agents.filter((a) => a.availability.available);
  const selectedCount = input.selected.size;
  const selectedAgent =
    input.currentAgent === 'auto'
      ? (availableAgents[0]?.agent.label ?? 'Automatic')
      : (input.agents.find((entry) => entry.agent.id === input.currentAgent)?.agent.label ?? 'Automatic');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${input.nonce}';">
<style>${STYLES}</style>
</head>
<body>
  <header class="top">
    <div>
      <h1>Drift</h1>
      <p>Dependency upgrades with evidence first, AI second.</p>
    </div>
    <button class="identity-action ${input.signedInLabel ? 'ok' : ''}" data-action="signIn">
      ${input.signedInLabel ? `GitHub: ${escapeHtml(input.signedInLabel)}` : 'Sign in to GitHub'}
    </button>
  </header>

  <details class="panel agents">
    <summary>
      <span>AI agent</span>
      <small>${escapeHtml(selectedAgent)}</small>
    </summary>
    <div class="agent-picker">
      <label for="agentSelect">Agent</label>
      <select id="agentSelect" data-action="setAgent">
        <option value="auto" ${input.currentAgent === 'auto' ? 'selected' : ''}>Automatic - best available</option>
        ${availableAgents.map((entry) => renderAgentOption(entry, input.currentAgent)).join('')}
      </select>
    </div>
    ${renderUnavailableAgents(input.agents.filter((entry) => !entry.availability.available))}
  </details>

  <details class="panel upgrades" open>
    <summary>
      <span>Upgrade Candidates</span>
      <small>${selectedCount} selected</small>
    </summary>
    <section class="toolbar">
      <button class="primary" data-action="scanUpgrades">${input.scanStatus === 'scanning' ? 'Scanning...' : 'Scan upgrades'}</button>
      <button data-action="analyzeRecent">Analyze recent change</button>
      <button data-action="upgradeSelected" data-mode="safe" ${selectedCount ? '' : 'disabled'}>Safe upgrade</button>
      <button data-action="upgradeSelected" data-mode="force" ${selectedCount ? '' : 'disabled'}>Force latest</button>
      <button data-action="fixSelected" ${selectedCount ? '' : 'disabled'}>Fix selected</button>
    </section>

    <section class="scan-state ${input.scanStatus}">
      <span class="dot"></span>
      <span>${escapeHtml(input.scanSummary)}</span>
    </section>

    <main class="cards">
      ${input.candidates.length ? input.candidates.map((c) => renderCandidate(c, input.selected.has(c.id))).join('') : renderEmptyCandidates(input.scanStatus)}
    </main>
  </details>

  <section class="chatbox" aria-label="Drift chat">
    <div class="messages">
      ${input.messages.map(renderMessage).join('')}
    </div>
    <form class="composer">
      <textarea name="text" rows="2" placeholder="Ask Drift or add fix instructions..."></textarea>
      <div class="composer-actions">
        <button type="button" class="icon" title="Mention file" data-action="pickFile">@F</button>
        <button type="button" class="icon" title="Mention folder" data-action="pickFolder">@D</button>
        <button class="send" type="submit" title="Send" aria-label="Send">↑</button>
      </div>
    </form>
  </section>

  <script nonce="${input.nonce}">${SCRIPT}</script>
</body>
</html>`;
}

function renderAgentOption(entry: DiscoveredAgent, currentAgent: string): string {
  return `<option value="${escapeAttr(entry.agent.id)}" ${entry.agent.id === currentAgent ? 'selected' : ''}>${escapeHtml(entry.agent.label)}</option>`;
}

function renderUnavailableAgents(agents: DiscoveredAgent[]): string {
  if (agents.length === 0) return '';
  return `<details class="unavailable-agents">
    <summary>${agents.length} unavailable agent${agents.length === 1 ? '' : 's'}</summary>
    <div class="agent-list">
      ${agents.map(renderUnavailableAgent).join('')}
    </div>
  </details>`;
}

function renderUnavailableAgent(entry: DiscoveredAgent): string {
  const signals = entry.availability.signals ?? [];
  return `<article class="agent-card unavailable">
    <div>
      <strong>${escapeHtml(entry.agent.label)}</strong>
      <small>${escapeHtml(entry.agent.kind)}</small>
    </div>
    <p>${escapeHtml(entry.availability.reason ?? entry.agent.description)}</p>
    ${entry.availability.detail ? `<code>${escapeHtml(entry.availability.detail)}</code>` : ''}
    ${signals.length ? `<div class="signals">${signals.map((signal) => `<span>${escapeHtml(signal)}</span>`).join('')}</div>` : ''}
  </article>`;
}

function renderCandidate(candidate: UpgradeCandidate, selected: boolean): string {
  const domId = domSafe(candidate.id);
  const hasRepoImpact = (candidate.plan?.impactSites.length ?? candidate.impactCount) > 0;
  const statusLabel =
    candidate.status === 'checking'
      ? 'Checking evidence'
      : candidate.status === 'upgrading'
        ? 'Updating files'
        : candidate.status === 'error'
          ? 'Needs attention'
          : candidate.breakingCount > 0
            ? `${candidate.breakingCount} breaking`
            : 'No breaking evidence';
  const canFix = Boolean(candidate.plan && candidate.plan.commits.length > 0);
  const safeLabel = candidate.safeLatest
    ? `safe ${candidate.safeLatest}`
    : 'no safe-range update';
  const forcedLabel =
    candidate.latest === candidate.selected ? `${candidate.latest} latest` : `latest ${candidate.latest}`;

  return `<details class="update-row ${candidate.breakingCount > 0 ? 'has-breaks' : 'clean'} ${hasRepoImpact ? 'repo-impact' : 'no-repo-impact'}" ${hasRepoImpact ? 'open' : ''}>
    <summary class="row-head">
      <label class="check">
        <input type="checkbox" data-action="toggleCandidate" data-id="${escapeAttr(candidate.id)}" ${selected ? 'checked' : ''} />
        <span></span>
      </label>
      <div class="package">
        <strong>${escapeHtml(candidate.name)}</strong>
        <small>${escapeHtml(candidate.kind)} · ${escapeHtml(candidate.current)} -> ${escapeHtml(candidate.selected)} · ${escapeHtml(statusLabel)}</small>
      </div>
      <span class="status-chip ${candidateStatusClass(candidate)}">${escapeHtml(hasRepoImpact ? 'found in repo' : statusLabel)}</span>
    </summary>

    <div class="version-row">
      <label>
        Target
        <select data-action="selectVersion" data-id="${escapeAttr(candidate.id)}">
        ${candidate.versions
          .map(
            (version) =>
              `<option value="${escapeAttr(version)}" ${version === candidate.selected ? 'selected' : ''}>${escapeHtml(version)}${version === candidate.latest ? ' latest' : ''}${version === candidate.safeLatest ? ' safe' : ''}</option>`,
          )
          .join('')}
        </select>
      </label>
      <div class="target-notes">
        <span class="${candidate.safeLatest ? 'ok' : 'muted'}">${escapeHtml(safeLabel)}</span>
        <span class="warn">${escapeHtml(forcedLabel)}</span>
      </div>
    </div>

    <div class="metrics">
      ${metric(String(candidate.breakingCount), 'upstream breaks', 'metric-break', candidate.breakingCount > 0 ? `#breaks-${domId}` : '', 'Open upstream break sources')}
      ${metric(String(candidate.impactCount), 'repo matches', 'metric-impact')}
      ${metric(String(candidate.evidenceCount), 'evidence', 'metric-evidence', candidate.evidenceCount > 0 ? `#evidence-${domId}` : '', 'Open evidence sources')}
      ${metric(candidate.risk, 'repo risk', `metric-risk risk-${candidate.risk}`, '', riskDetail(candidate))}
    </div>

    <div class="summary">${renderMarkdown(candidate.error ?? candidate.summary)}</div>
    ${renderCandidateBreakdown(candidate)}

    <div class="row-actions">
      <button data-action="upgradeCandidate" data-mode="safe" data-id="${escapeAttr(candidate.id)}" ${candidate.safeLatest ? '' : 'disabled'}>Safe upgrade</button>
      <button data-action="upgradeCandidate" data-mode="force" data-id="${escapeAttr(candidate.id)}">Force latest</button>
      <button class="primary" data-action="fixCandidate" data-id="${escapeAttr(candidate.id)}" ${canFix ? '' : 'disabled'}>Fix repo matches</button>
    </div>
  </details>`;
}

function renderCandidateBreakdown(candidate: UpgradeCandidate): string {
  const plan = candidate.plan;
  if (!plan) return '';
  const domId = domSafe(candidate.id);

  if (plan.breakingChanges.length === 0) {
    return `<details class="breakdown" id="evidence-${domId}">
      <summary>What Drift checked</summary>
      <p class="explain">No breaking change was identified in the available release notes, changelog, type surface, or registry evidence for this target version.</p>
      ${renderEvidenceList(plan.evidence)}
    </details>`;
  }

  const withSites = plan.breakingChanges.filter((change) =>
    plan.impactSites.some((site) => site.breakingChangeId === change.id),
  );
  const withoutSites = plan.breakingChanges.filter((change) =>
    !plan.impactSites.some((site) => site.breakingChangeId === change.id),
  );

  return `<div class="breakdown" id="breaks-${domId}">
    ${renderBreakGroup('Found in this repo', withSites, candidate, plan, true)}
    ${renderBreakGroup('Not found in this repo', withoutSites, candidate, plan, false)}
    <details class="break-group evidence-group" id="evidence-${domId}">
      <summary>
        <span>Evidence sources</span>
        <small>${plan.evidence.length} source${plan.evidence.length === 1 ? '' : 's'}</small>
      </summary>
      ${renderEvidenceList(plan.evidence)}
    </details>
  </div>`;
}

function renderBreakGroup(
  title: string,
  changes: readonly BreakingChange[],
  candidate: UpgradeCandidate,
  plan: RemediationPlan,
  open: boolean,
): string {
  if (changes.length === 0) return '';
  return `<details class="break-group" ${open ? 'open' : ''}>
    <summary>
      <span>${escapeHtml(title)}</span>
      <small>${changes.length} breaking change${changes.length === 1 ? '' : 's'}</small>
    </summary>
    ${changes.map((change) => renderBreakItem(change, candidate, plan)).join('')}
  </details>`;
}

function renderBreakItem(
  change: BreakingChange,
  candidate: UpgradeCandidate,
  plan: RemediationPlan,
): string {
  const evidence = plan.evidence.filter((entry) => change.citations.includes(entry.id));
  const sites = plan.impactSites.filter((site) => site.breakingChangeId === change.id);
  return `<section class="break ${sites.length ? 'matched' : 'unmatched'}">
    <div class="break-head">
      <span class="badge ${change.confidence}">${escapeHtml(change.confidence)}</span>
      <span>${escapeHtml(change.kind)}</span>
      <span class="impact-pill ${sites.length ? 'hit' : 'miss'}">${sites.length ? `${sites.length} repo match${sites.length === 1 ? '' : 'es'}` : 'not found here'}</span>
    </div>
    <h3>${escapeHtml(change.summary)}</h3>
    ${change.symbols.length ? `<p class="symbols">${change.symbols.map((symbol) => `<code>${escapeHtml(symbol)}</code>`).join(' ')}</p>` : ''}
    <details class="required-fix">
      <summary>Required fix</summary>
      <div>${renderMarkdown(change.remediation)}</div>
    </details>
    <p class="explain">${escapeHtml(riskReason(candidate, sites.length))}</p>
    ${
      sites.length
        ? `<ul class="sites">${sites
            .slice(0, 12)
            .map(
              (site) =>
                `<li><a data-action="openFile" data-file="${escapeAttr(site.file)}" data-line="${site.line}"><code>${escapeHtml(site.file)}:${site.line}</code></a><span>${escapeHtml(site.excerpt)}</span></li>`,
            )
            .join('')}</ul>`
        : '<p class="explain">Drift found this upstream breaking change, but did not find the affected symbols in this repository. No local edit is planned unless you decide to investigate it manually.</p>'
    }
    ${renderEvidenceList(evidence)}
  </section>`;
}

function renderEvidenceList(evidence: readonly Evidence[]): string {
  if (evidence.length === 0) return '<p class="explain">No evidence records are attached.</p>';
  return `<div class="evidence-list">
    ${evidence
      .slice(0, 6)
      .map(
        (entry) => `<details>
          <summary>
            <span class="source">${escapeHtml(entry.source)}</span>
            ${renderEvidenceTitle(entry)}
            <span class="weight">weight ${entry.weight.toFixed(2)}</span>
          </summary>
          <div class="markdown evidence-body">${renderMarkdown(entry.content.slice(0, 1800))}</div>
        </details>`,
      )
      .join('')}
  </div>`;
}

function renderEvidenceTitle(entry: Evidence): string {
  if (entry.url) return `<a data-action="openUrl" data-url="${escapeAttr(entry.url)}">${escapeHtml(entry.title)}</a>`;
  if (entry.locator) return `<span>${escapeHtml(entry.title)} · ${escapeHtml(entry.locator)}</span>`;
  return `<span>${escapeHtml(entry.title)}</span>`;
}

function riskDetail(candidate: UpgradeCandidate): string {
  if (candidate.risk !== 'none') return `Risk is ${candidate.risk} because breaking changes overlap local usage.`;
  if (candidate.breakingCount === 0) return 'Risk is none because no breaking change was identified for this version.';
  if (candidate.impactCount === 0) return 'Risk is none because Drift found breaking changes upstream but no local usage to fix.';
  return 'Risk is none because no actionable local edit is planned.';
}

function riskReason(candidate: UpgradeCandidate, siteCount: number): string {
  if (candidate.risk === 'none' && siteCount === 0) {
    return 'Risk is none for this finding because it was not found in the local codebase.';
  }
  if (candidate.risk === 'none') return riskDetail(candidate);
  return `This contributes to ${candidate.risk} risk because Drift found local code that may need to change.`;
}

function renderEmptyCandidates(status: string): string {
  if (status === 'scanning') {
    return '<div class="empty"><div class="spinner"></div><b>Scanning upgrade candidates</b><span>Reading package.json, npm metadata, release notes, and API surfaces.</span></div>';
  }
  return '<div class="empty"><b>No upgrade candidates loaded</b><span>Run a scan to compare installed packages with newer releases.</span></div>';
}

function renderMessage(message: Message): string {
  return `<div class="msg ${message.role}"><b>${message.role === 'user' ? 'You' : message.role === 'agent' ? 'Agent' : 'Drift'}</b><div class="markdown">${renderMarkdown(message.text)}</div></div>`;
}

function metric(value: string, label: string, className = '', target = '', title = ''): string {
  const content = `<b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span>`;
  if (target) {
    return `<button class="metric ${className} linked" data-action="revealSection" data-target="${escapeAttr(target)}" title="${escapeAttr(title)}">${content}</button>`;
  }
  return `<div class="metric ${className}" ${title ? `title="${escapeAttr(title)}"` : ''}>${content}</div>`;
}

function candidateStatusClass(candidate: UpgradeCandidate): string {
  if (candidate.status === 'error') return 'danger';
  if (candidate.impactCount > 0) return 'danger';
  if (candidate.breakingCount > 0) return 'warn';
  if (candidate.status === 'checking' || candidate.status === 'upgrading') return 'info';
  return 'ok';
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
      blocks.push(closeList(), `<h4>${inlineMarkdown(heading[2]!)}</h4>`);
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
      return `<a data-action="openUrl" data-url="${escapeAttr(url)}">${label}</a>`;
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

function domSafe(text: string): string {
  return text.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'candidate';
}

const SCRIPT = `
const vscode = acquireVsCodeApi();

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (target.tagName === 'SELECT' || target.type === 'checkbox') return;
  if (action === 'revealSection') {
    revealSection(target.dataset.target);
    return;
  }
  vscode.postMessage({
    type: action,
    id: target.dataset.id,
    mode: target.dataset.mode,
    file: target.dataset.file,
    line: Number(target.dataset.line),
    url: target.dataset.url,
  });
});

function revealSection(target) {
  if (!target) return;
  const id = target.startsWith('#') ? target.slice(1) : target;
  const section = document.getElementById(id);
  if (!section) return;
  let node = section;
  while (node) {
    if (node.tagName === 'DETAILS') node.open = true;
    node = node.parentElement;
  }
  section.scrollIntoView({ block: 'start', behavior: 'smooth' });
  section.classList.remove('revealed');
  requestAnimationFrame(() => section.classList.add('revealed'));
}

document.addEventListener('change', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  if (target.dataset.action === 'setAgent') {
    vscode.postMessage({ type: 'setAgent', id: target.value });
  }
  if (target.dataset.action === 'selectVersion') {
    vscode.postMessage({ type: 'selectVersion', id: target.dataset.id, version: target.value });
  }
  if (target.dataset.action === 'toggleCandidate') {
    vscode.postMessage({ type: 'toggleCandidate', id: target.dataset.id, selected: target.checked });
  }
});

document.querySelector('.composer')?.addEventListener('submit', (event) => {
  event.preventDefault();
  const input = event.currentTarget.elements.text;
  vscode.postMessage({ type: 'sendMessage', text: input.value });
  input.value = '';
});

window.addEventListener('message', (event) => {
  if (event.data?.type !== 'insertText') return;
  const input = document.querySelector('.composer [name="text"]');
  if (!input) return;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + event.data.text + input.value.slice(end);
  const next = start + event.data.text.length;
  input.focus();
  input.setSelectionRange(next, next);
});
`;

const STYLES = `
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 14px;
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background);
  font: var(--vscode-font-size) var(--vscode-font-family);
}
button, select, textarea { font: inherit; }
button {
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 5px;
  padding: 6px 10px;
  color: var(--vscode-button-secondaryForeground);
  background: var(--vscode-button-secondaryBackground);
  cursor: pointer;
}
button:hover { background: var(--vscode-button-secondaryHoverBackground); }
button.primary, button.send {
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
}
button.primary:hover, button.send:hover { background: var(--vscode-button-hoverBackground); }
button:disabled { cursor: default; opacity: .45; }
.top {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: flex-start;
  margin-bottom: 12px;
}
h1 { margin: 0; font-size: 18px; line-height: 1.2; }
h3 { margin: 6px 0; font-size: 13px; }
p { margin: 0; }
.top p, small, .summary, .scan-state, .empty span, .explain {
  color: var(--vscode-descriptionForeground);
}
.identity-action {
  white-space: nowrap;
  max-width: 46%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.identity-action.ok {
  color: var(--vscode-testing-iconPassed);
  border-color: var(--vscode-testing-iconPassed);
  background: transparent;
}
.panel {
  border: 1px solid var(--vscode-panel-border);
  background: var(--vscode-editorWidget-background);
  border-radius: 7px;
  margin-bottom: 12px;
  overflow: hidden;
}
.panel > summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px;
  cursor: pointer;
  font-weight: 600;
}
.panel > summary small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 400;
}
.panel[open] > summary { border-bottom: 1px solid var(--vscode-panel-border); }
.panel > :not(summary) { margin: 10px; }
.toolbar {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.agent-picker {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 8px;
}
.agent-picker label {
  color: var(--vscode-descriptionForeground);
}
select {
  min-width: 0;
  border: 1px solid var(--vscode-dropdown-border);
  color: var(--vscode-dropdown-foreground);
  background: var(--vscode-dropdown-background);
  border-radius: 5px;
  padding: 5px 7px;
}
.agent-list {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.agent-card {
  border: 1px solid var(--vscode-panel-border);
  border-left: 3px solid var(--vscode-descriptionForeground);
  border-radius: 6px;
  padding: 8px;
  background: var(--vscode-input-background);
}
.agent-card.available { border-left-color: var(--vscode-testing-iconPassed); }
.agent-card.unavailable { opacity: .78; }
.agent-card.active { border-color: var(--vscode-focusBorder); }
.agent-card div:first-child {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: baseline;
}
.agent-card p {
  margin-top: 4px;
  line-height: 1.35;
}
.agent-card code {
  display: block;
  margin-top: 5px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.signals {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 6px;
}
.signals span, .empty-chip {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 3px;
  padding: 2px 7px;
  color: var(--vscode-descriptionForeground);
}
.unavailable-agents {
  border-top: 1px solid var(--vscode-panel-border);
  padding-top: 8px;
}
.unavailable-agents > summary {
  cursor: pointer;
  color: var(--vscode-descriptionForeground);
}
.scan-state {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--vscode-charts-blue);
}
.scan-state.ready .dot { background: var(--vscode-testing-iconPassed); }
.scan-state.error .dot { background: var(--vscode-testing-iconFailed); }
.scan-state.scanning .dot { animation: pulse .8s infinite alternate; }
.cards {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.update-row {
  border: 1px solid var(--vscode-panel-border);
  border-left: 2px solid var(--vscode-descriptionForeground);
  background: var(--vscode-editorWidget-background);
  border-radius: 4px;
  overflow: hidden;
}
.update-row.has-breaks { border-left-color: var(--vscode-editorWarning-foreground); }
.update-row.repo-impact { border-left-color: var(--vscode-testing-iconFailed); }
.update-row.clean { border-left-color: var(--vscode-testing-iconPassed); }
.update-row > :not(summary) { margin: 10px; }
.row-head {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  padding: 10px;
  cursor: pointer;
  list-style: none;
}
.row-head::-webkit-details-marker { display: none; }
.update-row[open] > .row-head { border-bottom: 1px solid var(--vscode-panel-border); }
.package {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.package strong { overflow-wrap: anywhere; }
.status-chip {
  border-radius: 3px;
  padding: 2px 7px;
  font-size: 11px;
  white-space: nowrap;
}
.status-chip.ok { color: var(--vscode-testing-iconPassed); background: color-mix(in srgb, var(--vscode-testing-iconPassed) 14%, transparent); }
.status-chip.info { color: var(--vscode-charts-blue); background: color-mix(in srgb, var(--vscode-charts-blue) 14%, transparent); }
.status-chip.warn { color: var(--vscode-editorWarning-foreground); background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 14%, transparent); }
.status-chip.danger { color: var(--vscode-testing-iconFailed); background: color-mix(in srgb, var(--vscode-testing-iconFailed) 14%, transparent); }
.version-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 6px;
}
.version-row label {
  display: grid;
  gap: 4px;
  color: var(--vscode-descriptionForeground);
}
.version-row select { width: 100%; }
.target-notes {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.target-notes span {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 3px;
  padding: 2px 7px;
  font-size: 11px;
}
.target-notes .ok { color: var(--vscode-testing-iconPassed); border-color: var(--vscode-testing-iconPassed); }
.target-notes .warn { color: var(--vscode-editorWarning-foreground); border-color: var(--vscode-editorWarning-foreground); }
.target-notes .muted { color: var(--vscode-descriptionForeground); }
.check input { display: none; }
.check span {
  width: 18px;
  height: 18px;
  display: block;
  border-radius: 4px;
  border: 1px solid var(--vscode-checkbox-border);
  background: var(--vscode-checkbox-background);
}
.check input:checked + span {
  background: var(--vscode-button-background);
  border-color: var(--vscode-button-background);
}
.check input:checked + span::after {
  content: "";
  display: block;
  width: 9px;
  height: 5px;
  border-left: 2px solid var(--vscode-button-foreground);
  border-bottom: 2px solid var(--vscode-button-foreground);
  transform: rotate(-45deg);
  margin: 4px 0 0 4px;
}
.metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
  margin: 10px 0;
}
.metric {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  padding: 6px;
  min-width: 0;
  text-align: left;
  background: var(--vscode-input-background);
  color: var(--vscode-foreground);
}
.metric.linked {
  cursor: pointer;
}
.metric.linked:hover,
.metric.linked:focus {
  border-color: var(--vscode-focusBorder);
  outline: none;
}
.metric-break b { color: var(--vscode-editorWarning-foreground); }
.metric-impact b { color: var(--vscode-testing-iconFailed); }
.metric-evidence b { color: var(--vscode-charts-blue); }
.metric-risk.risk-none b { color: var(--vscode-testing-iconPassed); }
.metric-risk.risk-low b { color: var(--vscode-charts-blue); }
.metric-risk.risk-medium b { color: var(--vscode-editorWarning-foreground); }
.metric-risk.risk-high b { color: var(--vscode-testing-iconFailed); }
.metric b {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
}
.metric span {
  display: block;
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
}
.summary {
  margin-bottom: 10px;
  line-height: 1.35;
}
.breakdown {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 10px;
}
.break-group {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  overflow: hidden;
}
.break-group > summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px;
  cursor: pointer;
  font-weight: 600;
}
.break-group[open] > summary {
  border-bottom: 1px solid var(--vscode-panel-border);
}
.break-group summary small {
  color: var(--vscode-descriptionForeground);
  font-weight: 400;
}
.break {
  margin: 0;
  padding: 10px;
  border-top: 1px solid var(--vscode-panel-border);
}
.break:first-of-type { border-top: 0; }
.break.matched { background: color-mix(in srgb, var(--vscode-testing-iconFailed) 5%, transparent); }
.break-head {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
}
.badge {
  text-transform: uppercase;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border-radius: 3px;
  padding: 1px 5px;
}
.badge.high { background: var(--vscode-testing-iconFailed); color: var(--vscode-button-foreground); }
.badge.medium { background: var(--vscode-editorWarning-foreground); color: var(--vscode-editor-background); }
.badge.low { background: var(--vscode-charts-blue); color: var(--vscode-button-foreground); }
.impact-pill {
  margin-left: auto;
  border-radius: 3px;
  padding: 1px 7px;
}
.impact-pill.hit {
  color: var(--vscode-testing-iconFailed);
  background: color-mix(in srgb, var(--vscode-testing-iconFailed) 14%, transparent);
}
.impact-pill.miss {
  color: var(--vscode-descriptionForeground);
  border: 1px solid var(--vscode-panel-border);
}
.symbols {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}
.required-fix {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 5px;
  margin: 8px 0;
  padding: 6px;
}
.required-fix > summary {
  cursor: pointer;
  color: var(--vscode-textLink-foreground);
}
.sites {
  margin: 7px 0;
  padding: 0;
  list-style: none;
}
.sites li {
  margin-bottom: 4px;
  overflow-wrap: anywhere;
  display: grid;
  gap: 2px;
}
.evidence-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}
.evidence-list details {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 5px;
  padding: 6px;
}
.evidence-list summary {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  cursor: pointer;
  overflow-wrap: anywhere;
}
.evidence-list summary .weight {
  margin-left: auto;
  color: var(--vscode-descriptionForeground);
}
.evidence-group > .evidence-list {
  margin: 8px;
}
.revealed {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}
.source {
  font-size: 10px;
  text-transform: uppercase;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border-radius: 3px;
  padding: 1px 5px;
}
.evidence-body {
  max-height: 220px;
  overflow: auto;
  margin-top: 6px;
}
.markdown p { margin: 0 0 6px; }
.markdown p:last-child { margin-bottom: 0; }
.markdown ul { margin: 4px 0 6px; padding-left: 18px; }
.markdown h4 { margin: 8px 0 4px; font-size: 12px; }
code {
  font-family: var(--vscode-editor-font-family);
  font-size: .92em;
  background: var(--vscode-textCodeBlock-background);
  border-radius: 3px;
  padding: 1px 4px;
}
.row-actions {
  display: flex;
  gap: 8px;
}
.row-actions button { flex: 1; }
.empty {
  border: 1px dashed var(--vscode-panel-border);
  border-radius: 7px;
  padding: 18px 12px;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.spinner {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid var(--vscode-panel-border);
  border-top-color: var(--vscode-progressBar-background);
  margin: 0 auto;
  animation: spin .9s linear infinite;
}
.chatbox {
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  background: var(--vscode-input-background);
  border-radius: 6px;
  padding: 8px;
}
.chatbox:focus-within {
  border-color: var(--vscode-focusBorder);
}
.messages {
  display: flex;
  flex-direction: column-reverse;
  gap: 8px;
  max-height: 220px;
  overflow: auto;
  margin-bottom: 8px;
}
.msg {
  border-radius: 5px;
  padding: 8px;
  background: var(--vscode-editorWidget-background);
}
.msg b {
  display: block;
  margin-bottom: 3px;
}
.msg.user { border: 1px solid var(--vscode-focusBorder); }
.msg.agent { border: 1px solid var(--vscode-testing-iconPassed); }
.msg span {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.composer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 6px;
  align-items: stretch;
  border-top: 1px solid var(--vscode-panel-border);
  padding-top: 8px;
}
.composer-actions {
  display: flex;
  gap: 4px;
  align-items: end;
}
button.icon, button.send {
  width: 30px;
  height: 30px;
  padding: 0;
  display: inline-grid;
  place-items: center;
}
button.icon {
  font-size: 11px;
  background: transparent;
}
textarea {
  min-width: 0;
  resize: none;
  border: 0;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border-radius: 0;
  padding: 5px 0;
  outline: none;
}
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes pulse { from { opacity: .4; } to { opacity: 1; } }
`;
