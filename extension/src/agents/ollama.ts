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

  async run(task: FixTask, ctx: AgentContext): Promise<FixOutcome> {
    ctx.report(`Asking ${this.model} to fix ${task.files.length} file(s)…`);

    const prompt = [
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

    try {
      const response = await fetch(`${this.host}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
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
        return { status: 'failed', message: `Ollama returned ${response.status}.` };
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

      if (saysNoChanges(text)) {
        return { status: 'no-changes', message: `${this.model} reported no changes were needed.` };
      }

      const edits = parseFileBlocks(text);
      if (edits.length === 0) {
        return {
          status: 'failed',
          message: `${this.model} produced no file blocks in the expected format. Smaller local models often struggle with this; try a larger coding model.`,
        };
      }

      return { status: 'applied', edits, message: `${this.model} rewrote ${edits.length} file(s).` };
    } catch (err) {
      if (ctx.signal.aborted) return { status: 'failed', message: 'Cancelled.' };
      if (timeout.aborted) {
        return {
          status: 'failed',
          message: `${this.model} timed out. Local models are slow on large files — raise drift.agent.timeoutSeconds or use a smaller scope.`,
        };
      }
      return { status: 'failed', message: `Ollama failed: ${(err as Error).message}` };
    }
  }
}
