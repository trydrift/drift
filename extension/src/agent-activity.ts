import type { TaskActivityInput } from './session.js';

/**
 * Naming what an agent is doing, from the lines it prints.
 *
 * Kept apart from the fix flow, and free of any `vscode` import, because this
 * is the piece that decides what every row of the panel's activity drawer is
 * called — and it is worth being able to test that decision directly against
 * real agent output rather than only through a running extension.
 */

/**
 * Name one line of agent chatter by what it says.
 *
 * The previous version keyed off the pipe the line arrived on, which is why
 * every row in the panel read `STDERR`: these CLIs stream their reasoning to
 * stderr and reserve stdout for the final answer, so the stream name is close
 * to the least informative thing available about a line. Content is the only
 * honest signal — a shell command looks like a shell command whichever pipe it
 * came down, and a URL is a source the developer should be able to open.
 *
 * A line this cannot place is still the agent thinking out loud, so it lands
 * under `Thinking` rather than being labelled with a stream name or dropped.
 */
export function activityFromReport(message: string): TaskActivityInput {
  const text = stripAnsi(message).trim();
  const links = linksIn(text);

  const command = commandFromReport(text);
  if (command) {
    return { kind: 'bash', title: 'Bash', detail: command.detail, input: command.input, links };
  }

  // A line carrying a URL is the agent telling the developer which source it is
  // about to rely on. That is worth its own row, and worth a link.
  if (links?.length || /\b(web[ _-]?search|searching the web|fetch(ing)?|browsing)\b/i.test(text)) {
    return { kind: 'search', title: searchTitle(text), detail: text, links };
  }

  const file = /^(read|reading|write|writing|edit|editing|creat\w+|open\w*|search\w*|grep\w*|glob\w*|list\w*)\b/i.exec(text);
  if (file) {
    return { kind: 'status', title: statusTitle(text), detail: text, links };
  }

  if (/^(receiving|asking|waiting|applying|checking|running|thinking|planning|analyz\w+|analys\w+)\b/i.test(text)) {
    return { kind: 'status', title: statusTitle(text), detail: text, links };
  }

  return { kind: 'thinking', title: 'Thinking', detail: text, links };
}

/**
 * Terminal control sequences, which are formatting rather than content.
 *
 * Anchored on the escape character rather than on the bracket alone: an
 * unanchored `[…]` pattern also eats prose like "[1] see below", and the panel
 * would then be quietly rewriting what the agent said.
 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '');
}

function linksIn(text: string): string[] | undefined {
  const found = text.match(/https?:\/\/[^\s<>"'`)\]}]+/g);
  if (!found) return undefined;
  // Trailing punctuation belongs to the sentence, not to the URL.
  const cleaned = found.map((url) => url.replace(/[.,;:!?]+$/, ''));
  return [...new Set(cleaned)].slice(0, 8);
}

function searchTitle(text: string): string {
  if (/\bweb[ _-]?search\b|searching the web/i.test(text)) return 'Web search';
  if (/\bfetch/i.test(text)) return 'Fetch';
  return 'Source';
}

function commandFromReport(text: string): { detail?: string; input: string } | null {
  if (text.startsWith('$ ')) return { input: text };

  const running = /^Running\s+(\S+)(?:\s+with\s+(.+?))?\s+in\s+(.+?)…?$/i.exec(text);
  if (running) {
    const [, command, model, cwd] = running;
    return {
      detail: model ? `${command} with ${model}` : command,
      input: `cd ${cwd}\n${command}`,
    };
  }

  if (/^(npm|pnpm|yarn|bun|git|cargo|go|python|pytest|node|npx|deno|mvn|gradle)\b/.test(text)) {
    return { input: text };
  }

  return null;
}

function statusTitle(text: string): string {
  const word = text.split(/\s+/, 1)[0] ?? 'Working';
  return word.replace(/^[a-z]/, (c) => c.toUpperCase()).replace(/…$/, '');
}
