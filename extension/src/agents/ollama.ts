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
 * Ollama — a model running on the user's own machine.
 *
 * The privacy answer: nothing leaves the laptop. No account, no key, no
 * network egress. For teams who cannot send source code to a third party, this
 * is the only acceptable option, and Drift treats it as a first-class one.
 *
 * Small local models are meaningfully worse at large refactors than hosted
 * frontier models, so the UI is honest about that rather than pretending the
 * choice is free.
 */
export class OllamaAgent implements FixAgent {
  readonly id = 'ollama';
  readonly label = 'Ollama (local)';
  readonly description = 'A model on your own machine. Nothing leaves your laptop.';
  readonly kind = 'in-editor' as const;
  readonly acceptsCustomModel = true;

  constructor(
    private readonly host: string,
    private readonly model: string,
    private readonly timeoutMs: number,
  ) {}

  async detect(): Promise<AgentAvailability> {
    try {
      const response = await fetch(`${this.host}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) {
        return { available: false, reason: `Ollama replied ${response.status} at ${this.host}.` };
      }

      const data = (await response.json()) as { models?: { name: string }[] };
      const names = (data.models ?? []).map((m) => m.name);

      if (names.length === 0) {
        return {
          available: false,
          reason: `Ollama is running but has no models. Try \`ollama pull ${this.model}\`.`,
        };
      }

      // Tags carry an explicit version (`qwen2.5-coder:7b`); a configured name
      // without one should still match.
      const hasModel = names.some((n) => n === this.model || n.startsWith(`${this.model}:`));
      if (!hasModel) {
        return {
          available: false,
          reason: `Model "${this.model}" is not pulled. Run \`ollama pull ${this.model}\`, or pick one of: ${names.slice(0, 5).join(', ')}.`,
        };
      }

      return { available: true, detail: `${this.model} at ${this.host}` };
    } catch {
      return {
        available: false,
        reason: `No Ollama server at ${this.host}. Start it with \`ollama serve\`.`,
      };
    }
  }

  /** Every model actually pulled on this machine. Nothing to configure. */
  async listModels(): Promise<AgentModel[]> {
    try {
      const response = await fetch(`${this.host}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) return [];
      const data = (await response.json()) as { models?: { name: string; details?: { parameter_size?: string } }[] };
      return (data.models ?? []).map((model) => ({
        id: model.name,
        label: model.name,
        detail: model.details?.parameter_size ? `${model.details.parameter_size} on this machine` : 'On this machine',
        // A local model has no reasoning budget to spend, and the biggest ones
        // are already slow enough that "max" would only mean "waits longer".
        efforts: ['quick', 'balanced', 'thorough'],
      }));
    } catch {
      return [];
    }
  }

  async run(task: FixTask, ctx: AgentContext): Promise<FixOutcome> {
    const model = task.model || this.model;
    ctx.report(`Asking ${model} to fix ${task.files.length} file(s)…`);

    let prompt = [
      buildFixPrompt(task),
      '',
      buildEditProtocolInstructions(task.files),
      '',
      '## Current file contents',
      '',
      ...task.files.flatMap((f) => [`--- ${f.path} ---`, f.content, '']),
      '## Your task',
      '',
      task.commit.instructions,
    ].join('\n');

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = AbortSignal.any([ctx.signal, timeout]);

    // Two passes at most: one for the model to raise a question, one to act on
    // the answer. A model that only ever asks would otherwise never finish.
    for (let round = 0; round < 2; round += 1) {
      let text: string;
      try {
        text = await this.generate(model, prompt, signal, ctx);
      } catch (err) {
        if (ctx.signal.aborted) return { status: 'failed', message: 'Cancelled.' };
        if (timeout.aborted) {
          return {
            status: 'failed',
            message: `${model} timed out. Local models are slow on large files — raise drift.agent.timeoutSeconds or use a smaller scope.`,
          };
        }
        return { status: 'failed', message: `Ollama failed: ${(err as Error).message}` };
      }

      const question = round === 0 ? parseQuestion(text) : null;
      if (question && ctx.ask) {
        ctx.report('Waiting for your answer…');
        const answer = await ctx.ask(question.text, question.options);
        prompt = [
          prompt,
          '',
          '## Answer from the developer',
          '',
          answer
            ? `You asked: ${question.text}\nThey answered: ${answer}\n\nProceed on that basis and do not ask again.`
            : `You asked: ${question.text}\nThey did not answer. Make the safest change you can justify from the evidence and add a \`TODO(drift):\` comment wherever you were unsure.`,
        ].join('\n');
        continue;
      }

      if (saysNoChanges(text)) {
        return { status: 'no-changes', message: `${model} reported no changes were needed.` };
      }

      const edits = parseFileBlocks(text);
      if (edits.length === 0) {
        return {
          status: 'failed',
          message: `${model} produced no file blocks in the expected format. Smaller local models often struggle with this; try a larger coding model.`,
        };
      }

      return { status: 'applied', edits, message: `${model} rewrote ${edits.length} file(s).` };
    }

    return { status: 'failed', message: `${model} asked a question instead of editing.` };
  }

  /** One streaming completion, accumulated into text. */
  private async generate(model: string, prompt: string, signal: AbortSignal, ctx: AgentContext): Promise<string> {
    const response = await fetch(`${this.host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: true,
        options: {
          // Whole-file rewrites are long; a short context silently truncates
          // the reply and the result parses as a partial file.
          num_ctx: 16384,
        },
      }),
      signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`Ollama returned ${response.status}.`);
    }

    let text = '';
    let reported = 0;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line) as { response?: string };
          if (chunk.response) text += chunk.response;
        } catch {
          // A partial JSON line across chunk boundaries; the buffer handles it.
        }
      }

      if (text.length - reported > 2000) {
        reported = text.length;
        ctx.report(`Generating… (${Math.round(text.length / 1000)}k chars)`);
      }
    }

    return text;
  }
}
