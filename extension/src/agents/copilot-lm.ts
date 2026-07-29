import * as vscode from 'vscode';
import {
  buildEditProtocolInstructions,
  buildFixPrompt,
  parseFileBlocks,
  saysNoChanges,
  type AgentAvailability,
  type AgentContext,
  type FixAgent,
  type FixOutcome,
  type FixTask,
} from './types.js';

/**
 * GitHub Copilot, through VS Code's built-in Language Model API.
 *
 * This is the zero-configuration path: if the user has Copilot in their editor
 * — which most VS Code users who want this tool already do — there is nothing
 * to install, no key to paste, and no OAuth flow. VS Code handles consent with
 * its own permission prompt the first time a model is requested.
 */
export class CopilotLanguageModelAgent implements FixAgent {
  readonly id = 'copilot-lm';
  readonly label = 'GitHub Copilot';
  readonly description = 'Uses the model already available in your editor. No setup.';
  readonly kind = 'in-editor' as const;

  constructor(private readonly family?: string) {}

  async detect(): Promise<AgentAvailability> {
    const signals = copilotExtensionSignal();
    try {
      // Deliberately not filtered by family here: asking broadly tells us
      // whether Copilot is usable at all, which is the question being asked.
      const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      if (models.length === 0) {
        return {
          available: false,
          reason: signals.length
            ? 'Copilot is installed, but no Copilot model is available. Sign in to GitHub Copilot in VS Code.'
            : 'No Copilot model available. Install and sign in to GitHub Copilot in VS Code.',
          signals,
        };
      }
      return {
        available: true,
        detail: models.map((m) => m.family).join(', '),
        signals: [...signals, 'Copilot model access active'],
      };
    } catch (err) {
      return { available: false, reason: describeLmError(err), signals };
    }
  }

  async run(task: FixTask, ctx: AgentContext): Promise<FixOutcome> {
    const selector: vscode.LanguageModelChatSelector = this.family
      ? { vendor: 'copilot', family: this.family }
      : { vendor: 'copilot' };

    let models = await vscode.lm.selectChatModels(selector);
    if (models.length === 0 && this.family) {
      // A configured family that is no longer offered should degrade rather
      // than fail — the user's intent was "use Copilot", not "use exactly this".
      models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    }

    const model = models[0];
    if (!model) {
      return { status: 'failed', message: 'No Copilot model is available in this editor.' };
    }

    ctx.report(`Asking ${model.name} to fix ${task.commit.files.length} file(s)…`);

    const messages = [
      vscode.LanguageModelChatMessage.User(buildFixPrompt(task)),
      vscode.LanguageModelChatMessage.User(buildEditProtocolInstructions(task.files)),
      vscode.LanguageModelChatMessage.User(renderFiles(task)),
    ];

    const cancellation = toCancellationToken(ctx.signal);

    try {
      const response = await model.sendRequest(messages, {}, cancellation.token);

      let text = '';
      let lastReport = 0;
      for await (const fragment of response.text) {
        text += fragment;
        // Throttled so a long generation does not spam the progress UI.
        if (text.length - lastReport > 2000) {
          lastReport = text.length;
          ctx.report(`Receiving changes… (${Math.round(text.length / 1000)}k chars)`);
        }
      }

      if (saysNoChanges(text)) {
        return { status: 'no-changes', message: 'Copilot reported no changes were needed.' };
      }

      const edits = parseFileBlocks(text);
      if (edits.length === 0) {
        return {
          status: 'failed',
          message:
            'Copilot replied but produced no file blocks in the expected format. Nothing was changed.',
        };
      }

      return {
        status: 'applied',
        edits,
        message: `Copilot rewrote ${edits.length} file(s).`,
        warnings: extractTodos(edits),
      };
    } catch (err) {
      if (ctx.signal.aborted) {
        return { status: 'failed', message: 'Cancelled.' };
      }
      return { status: 'failed', message: describeLmError(err) };
    } finally {
      cancellation.dispose();
    }
  }
}

function copilotExtensionSignal(): string[] {
  const extension = vscode.extensions.all.find((entry) => entry.id.toLowerCase() === 'github.copilot');
  if (!extension) return [];
  const name = String(extension.packageJSON?.displayName ?? extension.packageJSON?.name ?? extension.id);
  const version = String(extension.packageJSON?.version ?? '').trim();
  return [`${name}${version ? ` ${version}` : ''} extension installed`];
}

function renderFiles(task: FixTask): string {
  const parts = ['## Current file contents', ''];
  for (const file of task.files) {
    parts.push(`--- ${file.path} ---`);
    parts.push(file.content);
    parts.push('');
  }
  parts.push('## Your task for THIS commit');
  parts.push('');
  parts.push(task.commit.instructions);
  return parts.join('\n');
}

/** Collect `TODO(drift)` markers so unresolved work is surfaced, not buried. */
export function extractTodos(edits: readonly { path: string; content: string }[]): string[] {
  const found: string[] = [];
  for (const edit of edits) {
    const lines = edit.content.split('\n');
    lines.forEach((line, i) => {
      if (line.includes('TODO(drift)')) {
        found.push(`${edit.path}:${i + 1} — ${line.trim().slice(0, 160)}`);
      }
    });
  }
  return found;
}

/** Bridge an AbortSignal to VS Code's cancellation model. */
function toCancellationToken(signal: AbortSignal): {
  token: vscode.CancellationToken;
  dispose: () => void;
} {
  const source = new vscode.CancellationTokenSource();
  const onAbort = () => source.cancel();

  if (signal.aborted) source.cancel();
  else signal.addEventListener('abort', onAbort, { once: true });

  return {
    token: source.token,
    dispose: () => {
      signal.removeEventListener('abort', onAbort);
      source.dispose();
    },
  };
}

function describeLmError(err: unknown): string {
  if (err instanceof vscode.LanguageModelError) {
    if (/consent|permission/i.test(err.message)) {
      return 'Permission to use Copilot was declined. Run the command again and choose Allow.';
    }
    if (/quota|rate/i.test(err.message)) {
      return 'Copilot quota or rate limit reached. Try again shortly.';
    }
    return `Copilot error: ${err.message}`;
  }
  return `Copilot error: ${(err as Error)?.message ?? String(err)}`;
}
