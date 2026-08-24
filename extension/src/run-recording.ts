import * as vscode from 'vscode';

/** VS Code user/workspace preference for repo-local diagnostic run artifacts. */
export function shouldRecordRuns(): boolean {
  return vscode.workspace.getConfiguration('drift').get<boolean>('diagnostics.recordRuns', false);
}
