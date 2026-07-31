import * as vscode from 'vscode';
import {
  buildEditProtocolInstructions,
  buildFixPrompt,
  parseFileBlocks,
  parseQuestion,
  saysNoChanges,
  type AgentAvailability,
  type AgentContext,
  type AgentModel,
  type FixAgent,
  type FixOutcome,
  type FixTask,
} from './types.js';

/**
 * Any chat model the editor itself exposes, through the Language Model API.
 *
 * This is the zero-configuration path, and it is deliberately not tied to one
 * vendor. VS Code lets any extension register chat models, so a developer with
 * a Grok, Qwen, Mistral or in-house provider extension installed already has a
 * subscription Drift can drive — and Drift finds it by asking the editor what is
 * there rather than by shipping a list of vendors it has heard of. Nothing to
 * install, no key to paste, no OAuth flow; VS Code handles consent with its own
 * permission prompt the first time a model is requested.
 */
export class LanguageModelAgent implements FixAgent {
  readonly kind = 'in-editor' as const;

  constructor(
    readonly id: string,
    readonly label: string,
    readonly description: string,
    protected readonly vendor: string,
    protected readonly family?: string,
  ) {}

  async detect(): Promise<AgentAvailability> {
    try {
      // Deliberately not filtered by family: asking broadly tells us whether
      // this vendor is usable at all, which is the question being asked.
      const models = await vscode.lm.selectChatModels({ vendor: this.vendor });
      if (models.length === 0) {
        return { available: false, reason: `No ${this.label} model is available in this editor.` };
      }
      return { available: true, detail: models.map((m) => m.name || m.family).join(', ') };
    } catch (err) {
      return { available: false, reason: describeLmError(err, this.label) };
    }
  }

  /**
   * Whatever this subscription is currently offering.
   *
   * Asked live rather than hardcoded: the families behind a seat change with the
   * plan and with whatever the provider rolled out this month, and a stale list
   * would offer models the editor will refuse.
   */
  async listModels(): Promise<AgentModel[]> {
    const models = await Promise.resolve(vscode.lm.selectChatModels({ vendor: this.vendor })).catch(
      () => [] as vscode.LanguageModelChat[],
    );

    // Families repeat across versions; the family is what `selectChatModels`
    // takes back, so it is the identity that matters here.
    const seen = new Set<string>();
    const out: AgentModel[] = [];
    for (const model of models) {
      if (seen.has(model.family)) continue;
      seen.add(model.family);
      out.push({
        id: model.family,
        label: model.name || model.family,
        detail: `${Math.round(model.maxInputTokens / 1000)}k context`,
        // The Language Model API exposes no reasoning budget, so offering "Max"
        // would be a control that quietly does nothing.
        efforts: ['quick', 'balanced', 'thorough'],
      });
    }
    return out;
  }

  async run(task: FixTask, ctx: AgentContext): Promise<FixOutcome> {
    const family = task.model || this.family;
    const selector: vscode.LanguageModelChatSelector = family
      ? { vendor: this.vendor, family }
      : { vendor: this.vendor };

    let models = await vscode.lm.selectChatModels(selector);
    if (models.length === 0 && family) {
      // A configured family that is no longer offered should degrade rather than
      // fail — the intent was "use this subscription", not "use exactly this".
      models = await vscode.lm.selectChatModels({ vendor: this.vendor });
    }

    const model = models[0];
    if (!model) {
      return { status: 'failed', message: `No ${this.label} model is available in this editor.` };
    }

    ctx.report(`Asking ${model.name} to fix ${task.commit.files.length} file(s)…`);

    const messages = [
      vscode.LanguageModelChatMessage.User(buildFixPrompt(task)),
      vscode.LanguageModelChatMessage.User(buildEditProtocolInstructions(task.files)),
      vscode.LanguageModelChatMessage.User(renderFiles(task)),
    ];

    const cancellation = toCancellationToken(ctx.signal);

    try {
      // Two rounds at most: one for the model to ask a question, one to act on
      // the answer. Any more and an agent that likes asking could loop forever.
      for (let round = 0; round < 2; round += 1) {
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

        const question = parseQuestion(text);
        if (question && ctx.ask && round === 0) {
          ctx.report('Waiting for your answer…');
          const answer = await ctx.ask(question.text, question.options);
          messages.push(
            vscode.LanguageModelChatMessage.Assistant(text.trim()),
            vscode.LanguageModelChatMessage.User(
              answer
                ? `The developer answered: ${answer}\n\nProceed with the fix on that basis. Do not ask again.`
                : 'The developer did not answer. Make the safest change you can justify from the evidence, and add a `TODO(drift):` comment wherever you were unsure.',
            ),
          );
          continue;
        }

        if (saysNoChanges(text)) {
          return { status: 'no-changes', message: `${model.name} reported no changes were needed.` };
        }

        const edits = parseFileBlocks(text);
        if (edits.length === 0) {
          return {
            status: 'failed',
            message: `${model.name} replied but produced no file blocks in the expected format. Nothing was changed.`,
          };
        }

        return {
          status: 'applied',
          edits,
          message: `${model.name} rewrote ${edits.length} file(s).`,
          warnings: extractTodos(edits),
        };
      }

      return { status: 'failed', message: `${model.name} kept asking questions instead of editing.` };
    } catch (err) {
      if (ctx.signal.aborted) {
        return { status: 'failed', message: 'Cancelled.' };
      }
      return { status: 'failed', message: describeLmError(err, this.label) };
    } finally {
      cancellation.dispose();
    }
  }
}

/**
 * The Copilot seat, which gets its own class only for its setup advice.
 *
 * Everything else about it is the general case; what is worth spelling out is
 * the difference between "not installed" and "installed but not signed in",
 * because those have different fixes and Copilot is the one most people have.
 */
export class CopilotLanguageModelAgent extends LanguageModelAgent {
  constructor(family?: string) {
    super('copilot-lm', 'Copilot', 'Uses the model already available in your editor. No setup.', 'copilot', family);
  }

  override async detect(): Promise<AgentAvailability> {
    const signals = copilotExtensionSignal();
    const base = await super.detect();

    if (base.available) return { ...base, signals: [...signals, 'Copilot model access active'] };

    return {
      ...base,
      reason: signals.length
        ? 'Copilot is installed, but no Copilot model is available. Sign in to GitHub Copilot in VS Code.'
        : 'No Copilot model available. Install and sign in to GitHub Copilot in VS Code.',
      signals,
    };
  }
}

/**
 * Every other vendor with models registered in this editor.
 *
 * This is what makes Drift genuinely model-agnostic rather than
 * agnostic-in-principle: whatever a developer has — xAI, Alibaba, Mistral, a
 * company-internal gateway — arrives as its own subscription with its own model
 * list, without Drift knowing the vendor's name in advance.
 */
export async function discoverLanguageModelAgents(): Promise<LanguageModelAgent[]> {
  const models = await Promise.resolve(vscode.lm.selectChatModels({})).catch(
    () => [] as vscode.LanguageModelChat[],
  );

  const vendors = new Map<string, vscode.LanguageModelChat[]>();
  for (const model of models) {
    if (!model.vendor || model.vendor === 'copilot') continue;
    const found = vendors.get(model.vendor);
    if (found) found.push(model);
    else vendors.set(model.vendor, [model]);
  }

  return [...vendors].map(
    ([vendor, found]) =>
      new LanguageModelAgent(
        `lm:${vendor}`,
        prettyVendor(vendor, found),
        `${found.length} model${found.length === 1 ? '' : 's'} registered in this editor.`,
        vendor,
      ),
  );
}

/**
 * A vendor id is a slug; a person needs a name.
 *
 * The API exposes no display name for a vendor, so this makes the slug
 * presentable — "xai" becomes "xAI" only because a model told us so, otherwise
 * "mistral" simply becomes "Mistral".
 */
function prettyVendor(vendor: string, models: readonly vscode.LanguageModelChat[]): string {
  const named = models.find((model) => model.name?.toLowerCase().startsWith(vendor.toLowerCase()));
  if (named?.name) return named.name.slice(0, vendor.length);
  return vendor.charAt(0).toUpperCase() + vendor.slice(1);
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

function describeLmError(err: unknown, label: string): string {
  if (err instanceof vscode.LanguageModelError) {
    if (/consent|permission/i.test(err.message)) {
      return `Permission to use ${label} was declined. Run the command again and choose Allow.`;
    }
    if (/quota|rate/i.test(err.message)) {
      return `${label} quota or rate limit reached. Try again shortly.`;
    }
    return `${label} error: ${err.message}`;
  }
  return `${label} error: ${(err as Error)?.message ?? String(err)}`;
}
