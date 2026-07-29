import * as vscode from 'vscode';
import { join } from 'node:path';
import type { BreakingChange, DependencyChange, ImpactSite } from '../../../src/types.js';
import type { DriftState } from '../state.js';

/**
 * The Drift tree.
 *
 * Structure mirrors how a person actually reasons about the problem:
 *
 *   dependency that moved
 *     └── what broke about it        (confidence badge, evidence link)
 *           └── where it bites here  (click to jump to the exact line)
 *
 * Every leaf is clickable and lands on the precise line. That is the whole
 * point of the localization stage, and burying it behind a text report would
 * waste it.
 */

export type DriftNode =
  | { type: 'message'; label: string; detail?: string; icon?: string; command?: vscode.Command }
  | { type: 'section'; label: string; detail?: string; icon: string; children: DriftNode[] }
  | { type: 'checked-dependency'; change: DependencyChange }
  | { type: 'dependency'; change: DependencyChange }
  | { type: 'breaking'; change: BreakingChange }
  | { type: 'site'; site: ImpactSite; change: BreakingChange }
  | { type: 'commit'; order: number; message: string; files: string[] }
  | { type: 'commits-root' };

export class DriftTreeProvider implements vscode.TreeDataProvider<DriftNode> {
  private readonly emitter = new vscode.EventEmitter<DriftNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly state: DriftState) {
    state.onDidChange(() => this.emitter.fire(undefined));
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(node: DriftNode): vscode.TreeItem {
    switch (node.type) {
      case 'message':
        return messageItem(node);
      case 'section':
        return sectionItem(node);
      case 'checked-dependency':
        return checkedDependencyItem(node.change);
      case 'dependency':
        return dependencyItem(node.change);
      case 'breaking':
        return breakingItem(node.change, this.state);
      case 'site':
        return siteItem(node.site, this.state);
      case 'commits-root':
        return commitsRootItem(this.state);
      case 'commit':
        return commitItem(node);
    }
  }

  getChildren(node?: DriftNode): DriftNode[] {
    const status = this.state.status;

    if (!node) return this.rootNodes();

    const plan = this.state.plan;
    if (node.type === 'section') return node.children;
    if (!plan) return [];

    if (node.type === 'dependency') {
      return plan.breakingChanges
        .filter((c) => c.dependency === node.change.name)
        .map((change) => ({ type: 'breaking', change }) as const);
    }

    if (node.type === 'breaking') {
      return plan.impactSites
        .filter((s) => s.breakingChangeId === node.change.id)
        .map((site) => ({ type: 'site', site, change: node.change }) as const);
    }

    if (node.type === 'commits-root') {
      return plan.commits.map(
        (c) => ({ type: 'commit', order: c.order, message: c.message, files: c.files }) as const,
      );
    }

    void status;
    return [];
  }

  private rootNodes(): DriftNode[] {
    const status = this.state.status;

    switch (status.kind) {
      case 'no-repo':
        return [
          {
            type: 'message',
            label: 'No git repository',
            detail: 'Open a folder that is a git repository.',
            icon: 'source-control',
          },
        ];

      case 'idle':
        return [
          {
            type: 'message',
            label: 'Check for breaking changes',
            detail: 'Analyse this repository',
            icon: 'play',
            command: { command: 'drift.analyze', title: 'Analyze' },
          },
        ];

      case 'analysing':
        return [{ type: 'message', label: status.detail, icon: 'loading~spin' }];

      case 'clean':
        return cleanNodes(status);

      case 'error':
        return [
          {
            type: 'message',
            label: 'Analysis failed',
            detail: status.message,
            icon: 'error',
            command: { command: 'drift.showLog', title: 'Show log' },
          },
        ];

      case 'delegated':
        return [
          {
            type: 'message',
            label: 'Running on GitHub',
            detail: status.message,
            icon: 'github',
            command: status.url
              ? { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.parse(status.url)] }
              : undefined,
          },
        ];

      case 'fixed':
        return [
          {
            type: 'message',
            label: `${status.commits} commit(s) on ${status.branch}`,
            detail: status.warnings.length
              ? `${status.warnings.length} thing(s) need your attention`
              : 'Review the diff, then push when ready',
            icon: status.warnings.length ? 'warning' : 'pass-filled',
            command: { command: 'drift.showReport', title: 'Show report' },
          },
          ...this.findingNodes(),
        ];

      case 'findings':
      case 'fixing':
        return this.findingNodes();
    }
  }

  private findingNodes(): DriftNode[] {
    const plan = this.state.plan;
    if (!plan) return [];

    const withFindings = plan.changes.filter((c) =>
      plan.breakingChanges.some((b) => b.dependency === c.name),
    );

    const nodes: DriftNode[] = withFindings.map(
      (change) => ({ type: 'dependency', change }) as const,
    );

    if (plan.commits.length > 0) nodes.push({ type: 'commits-root' });

    return nodes;
  }
}

/* ---------------- item rendering ---------------- */

function messageItem(node: Extract<DriftNode, { type: 'message' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
  item.description = node.detail;
  item.tooltip = node.detail;
  if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon);
  if (node.command) item.command = node.command;
  return item;
}

function sectionItem(node: Extract<DriftNode, { type: 'section' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
  item.description = node.detail;
  item.tooltip = node.detail;
  item.iconPath = new vscode.ThemeIcon(node.icon);
  return item;
}

function checkedDependencyItem(change: DependencyChange): vscode.TreeItem {
  const item = new vscode.TreeItem(change.name, vscode.TreeItemCollapsibleState.None);
  item.description = `${change.from ?? '—'} → ${change.to ?? '—'}`;
  item.iconPath = new vscode.ThemeIcon('package');
  item.contextValue = 'drift.checkedDependency';
  item.tooltip = new vscode.MarkdownString(
    [
      `**${change.name}**`,
      '',
      `${change.from ?? '—'} → ${change.to ?? '—'} (${change.bump})`,
      '',
      `Ecosystem: ${change.ecosystem}`,
      `Declared in: \`${change.manifestPath}\``,
      '',
      'No breaking evidence from this version change was found.',
    ].join('\n'),
  );
  return item;
}

function dependencyItem(change: DependencyChange): vscode.TreeItem {
  const item = new vscode.TreeItem(change.name, vscode.TreeItemCollapsibleState.Expanded);
  item.description = `${change.from ?? '—'} → ${change.to ?? '—'}`;
  item.iconPath = new vscode.ThemeIcon('package');
  item.contextValue = 'drift.dependency';
  item.tooltip = new vscode.MarkdownString(
    [
      `**${change.name}**`,
      '',
      `${change.from ?? '—'} → ${change.to ?? '—'} (${change.bump})`,
      '',
      `Ecosystem: ${change.ecosystem}`,
      `Declared in: \`${change.manifestPath}\``,
    ].join('\n'),
  );
  return item;
}

function cleanNodes(status: Extract<DriftState['status'], { kind: 'clean' }>): DriftNode[] {
  const plan = status.plan;

  if (!plan) {
    return [
      {
        type: 'message',
        label: 'Nothing to analyse yet',
        detail: 'Drift needs a dependency change in git or your working tree.',
        icon: 'search',
        command: { command: 'drift.analyze', title: 'Check again' },
      },
      {
        type: 'message',
        label: 'Try an update candidate',
        detail: 'Update a dependency locally, then run Drift before committing.',
        icon: 'arrow-up',
      },
    ];
  }

  const checked = plan.changes.length;
  const evidenceCount = plan.evidence.length;
  const warnings = plan.warnings.length;
  const shown = plan.changes.slice(0, 12);
  const hidden = Math.max(0, plan.changes.length - shown.length);

  return [
    {
      type: 'message',
      label: 'No breaking changes found',
      detail: `${checked} dependency change${checked === 1 ? '' : 's'} checked · ${evidenceCount} evidence record${evidenceCount === 1 ? '' : 's'}`,
      icon: 'pass-filled',
      command: { command: 'drift.showReport', title: 'Show report' },
    },
    {
      type: 'section',
      label: 'Checked Dependencies',
      detail: hidden ? `${shown.length} shown, ${hidden} more in report` : `${shown.length}`,
      icon: 'checklist',
      children: [
        ...shown.map((change) => ({ type: 'checked-dependency', change }) as const),
        ...(hidden
          ? [
              {
                type: 'message',
                label: `${hidden} more`,
                detail: 'Open the report to see the full list.',
                icon: 'ellipsis',
                command: { command: 'drift.showReport', title: 'Show report' },
              } as const,
            ]
          : []),
      ],
    },
    {
      type: 'section',
      label: 'Next',
      detail: warnings ? `${warnings} note${warnings === 1 ? '' : 's'}` : undefined,
      icon: 'sparkle',
      children: [
        {
          type: 'message',
          label: 'Re-check recent dependency changes',
          detail: 'Looks at uncommitted manifests or the latest manifest commit.',
          icon: 'refresh',
          command: { command: 'drift.analyze', title: 'Analyze' },
        },
        {
          type: 'message',
          label: 'Upgrade candidates',
          detail: 'Next step: compare installed versions with newer releases.',
          icon: 'versions',
        },
      ],
    },
  ];
}

const CONFIDENCE_ICON: Record<string, { icon: string; color: string }> = {
  high: { icon: 'error', color: 'charts.red' },
  medium: { icon: 'warning', color: 'charts.yellow' },
  low: { icon: 'info', color: 'charts.blue' },
};

function breakingItem(change: BreakingChange, state: DriftState): vscode.TreeItem {
  const plan = state.plan;
  const siteCount = plan?.impactSites.filter((s) => s.breakingChangeId === change.id).length ?? 0;

  const item = new vscode.TreeItem(
    change.summary,
    siteCount > 0
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None,
  );

  const badge = CONFIDENCE_ICON[change.confidence] ?? CONFIDENCE_ICON.low!;
  item.iconPath = new vscode.ThemeIcon(badge.icon, new vscode.ThemeColor(badge.color));
  item.description = siteCount > 0 ? `${siteCount} site${siteCount === 1 ? '' : 's'}` : 'not used here';
  item.contextValue = 'drift.breakingChange';

  const evidence = (plan?.evidence ?? []).filter((e) => change.citations.includes(e.id));

  const md = new vscode.MarkdownString(
    [
      `**${change.summary}**`,
      '',
      `Confidence: **${change.confidence}** · Type: \`${change.kind}\``,
      '',
      `**Fix:** ${change.remediation}`,
      '',
      evidence.length ? '**Evidence:**' : '',
      ...evidence.map((e) => (e.url ? `- [${e.title}](${e.url})` : `- ${e.title}`)),
    ]
      .filter(Boolean)
      .join('\n'),
  );
  md.isTrusted = true;
  item.tooltip = md;

  return item;
}

function siteItem(site: ImpactSite, state: DriftState): vscode.TreeItem {
  const item = new vscode.TreeItem(site.excerpt.trim(), vscode.TreeItemCollapsibleState.None);

  const where = site.enclosingSymbol ? `${site.enclosingSymbol} · ` : '';
  item.description = `${where}${site.file}:${site.line}`;
  item.iconPath = new vscode.ThemeIcon('symbol-method');
  item.contextValue = 'drift.impactSite';

  const root = state.workspaceRoot;
  if (root) {
    const uri = vscode.Uri.file(join(root, site.file));
    // `selection` puts the cursor on the exact line, not just the file.
    item.command = {
      command: 'vscode.open',
      title: 'Go to impact site',
      arguments: [
        uri,
        {
          selection: new vscode.Range(site.line - 1, 0, site.line - 1, 0),
          preview: true,
        } satisfies vscode.TextDocumentShowOptions,
      ],
    };
  }

  item.tooltip = `${site.file}:${site.line}\nmatched: ${site.matchedSymbol}\nconfidence: ${site.confidence}`;
  return item;
}

function commitsRootItem(state: DriftState): vscode.TreeItem {
  const count = state.plan?.commits.length ?? 0;
  const item = new vscode.TreeItem(
    `Planned commits (${count})`,
    vscode.TreeItemCollapsibleState.Collapsed,
  );
  item.iconPath = new vscode.ThemeIcon('git-commit');
  item.contextValue = 'drift.commits';
  item.tooltip = 'One commit per concern, so you can review or revert each independently.';
  return item;
}

function commitItem(node: Extract<DriftNode, { type: 'commit' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(node.message, vscode.TreeItemCollapsibleState.None);
  item.description = `${node.files.length} file${node.files.length === 1 ? '' : 's'}`;
  item.iconPath = new vscode.ThemeIcon('git-commit');
  item.contextValue = 'drift.commit';
  item.tooltip = node.files.join('\n');
  item.command = {
    command: 'drift.fixCommit',
    title: 'Fix just this commit',
    arguments: [node.order],
  };
  return item;
}
