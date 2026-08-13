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
 *
 * `Thinking` was where almost everything used to land, which made the drawer
 * useless for the question it exists to answer — *what did the agent actually
 * do to my repository?* Reading a file and rewriting one are not the same
 * event, and a reader skimming forty rows should be able to see the difference
 * without opening any of them. The two recognisers below are what buys that:
 * the tool-call form these CLIs print when they invoke a tool, and the plain
 * verb-and-path prose they print when they narrate one.
 */
export function activityFromReport(message: string): TaskActivityInput {
  const text = stripAnsi(message).trim();
  const links = linksIn(text);

  // The strongest signal available: the agent naming the tool it is running.
  const tool = toolCall(text);
  if (tool) return { ...tool, links };

  const command = commandFromReport(text);
  if (command) {
    return { kind: 'bash', title: 'Bash', detail: command.detail, input: command.input, links };
  }

  // A line carrying a URL is the agent telling the developer which source it is
  // about to rely on. That is worth its own row, and worth a link.
  if (links?.length || /\b(web[ _-]?search|searching the web|fetch(ing)?|browsing)\b/i.test(text)) {
    return { kind: 'search', title: searchTitle(text), detail: text, links };
  }

  const narrated = fileVerb(text);
  if (narrated) return { ...narrated, links };

  if (/^(receiving|asking|waiting|applying|checking|running|thinking|planning|analyz\w+|analys\w+)\b/i.test(text)) {
    return { kind: 'status', title: statusTitle(text), detail: text, links };
  }

  return { kind: 'thinking', title: 'Thinking', detail: text, links };
}

/**
 * What each tool an agent can call amounts to, in the reader's terms.
 *
 * Keyed by the tool's own name lowercased, because that is what the CLIs
 * print. The distinction that matters most here is `Write` versus `Edit`:
 * every one of these agents uses `Write`/`WriteFile` for "put this file
 * there, existing or not" and a separate verb for "change these lines", and
 * collapsing the two would hide the one case a reviewer most wants to catch —
 * a file appearing that they never had.
 */
const TOOLS: Record<string, { kind: TaskActivityInput['kind']; title: string }> = {
  read: { kind: 'read', title: 'Read' },
  readfile: { kind: 'read', title: 'Read' },
  readmanyfiles: { kind: 'read', title: 'Read' },
  notebookread: { kind: 'read', title: 'Read' },
  view: { kind: 'read', title: 'Read' },
  cat: { kind: 'read', title: 'Read' },
  open: { kind: 'read', title: 'Read' },
  ls: { kind: 'read', title: 'List' },
  list: { kind: 'read', title: 'List' },
  listdirectory: { kind: 'read', title: 'List' },

  write: { kind: 'create', title: 'Create' },
  writefile: { kind: 'create', title: 'Create' },
  create: { kind: 'create', title: 'Create' },
  createfile: { kind: 'create', title: 'Create' },

  edit: { kind: 'edit', title: 'Edit' },
  multiedit: { kind: 'edit', title: 'Edit' },
  update: { kind: 'edit', title: 'Edit' },
  replace: { kind: 'edit', title: 'Edit' },
  strreplace: { kind: 'edit', title: 'Edit' },
  str_replace: { kind: 'edit', title: 'Edit' },
  applypatch: { kind: 'edit', title: 'Edit' },
  apply_patch: { kind: 'edit', title: 'Edit' },
  notebookedit: { kind: 'edit', title: 'Edit' },

  bash: { kind: 'bash', title: 'Bash' },
  shell: { kind: 'bash', title: 'Bash' },
  exec: { kind: 'bash', title: 'Bash' },
  run: { kind: 'bash', title: 'Bash' },
  runcommand: { kind: 'bash', title: 'Bash' },
  terminal: { kind: 'bash', title: 'Bash' },

  grep: { kind: 'search', title: 'Grep' },
  ripgrep: { kind: 'search', title: 'Grep' },
  searchtext: { kind: 'search', title: 'Grep' },
  glob: { kind: 'search', title: 'Glob' },
  findfiles: { kind: 'search', title: 'Glob' },
  search: { kind: 'search', title: 'Search' },
  websearch: { kind: 'search', title: 'Web search' },
  webfetch: { kind: 'search', title: 'Fetch' },
  fetch: { kind: 'search', title: 'Fetch' },

  task: { kind: 'status', title: 'Subtask' },
  todowrite: { kind: 'status', title: 'Plan' },
  think: { kind: 'thinking', title: 'Thinking' },
};

/**
 * A tool invocation, in the `Name(arguments)` form these CLIs print.
 *
 * Leading bullets and status glyphs are theirs, not content — Claude Code
 * prefixes with `⏺`, others use `●`, `>` or a dash — so they are stripped
 * before matching rather than being allowed to defeat it.
 */
function toolCall(text: string): TaskActivityInput | null {
  const match = /^[\s⏺●○◆◇•*>\-]*([A-Za-z][A-Za-z_]{1,24})\s*\(([\s\S]*)\)\s*$/.exec(text);
  if (!match) return null;

  const entry = TOOLS[match[1]!.toLowerCase().replace(/_/g, '')] ?? TOOLS[match[1]!.toLowerCase()];
  if (!entry) return null;

  const argument = match[2]!.trim();
  const path = pathIn(argument);

  // A shell tool's argument *is* the command, and belongs in the row's `IN`
  // block where it can be read in full rather than truncated into a subtitle.
  if (entry.kind === 'bash') {
    return { kind: entry.kind, title: entry.title, input: argument || undefined };
  }

  return {
    kind: entry.kind,
    title: entry.title,
    ...(path ? { file: path } : {}),
    ...(argument && argument !== path ? { detail: argument.slice(0, 400) } : {}),
  };
}

/**
 * The same events, narrated in prose rather than printed as a call.
 *
 * Only claimed when the verb is unambiguous about what happened to a file.
 * "Applying" and "checking" are deliberately absent: they describe an agent
 * mid-stride rather than a file changing, and promoting them to `Edit` would
 * put a row in the drawer implying a write that may never have happened.
 */
function fileVerb(text: string): TaskActivityInput | null {
  const match = /^(read|reading|reads|open(?:ing|ed)?|view(?:ing|ed)?|list(?:ing|ed)?|writ(?:e|ing)|wrote|creat(?:e|ing|ed)|add(?:ing|ed)|edit(?:ing|ed)?|updat(?:e|ing|ed)|modif(?:y|ying|ied)|replac(?:e|ing|ed)|delet(?:e|ing|ed)|remov(?:e|ing|ed)|search(?:ing|ed)?|grep\w*|glob\w*)\b(.*)$/i.exec(
    text,
  );
  if (!match) return null;

  const verb = match[1]!.toLowerCase();
  const rest = match[2] ?? '';
  const path = pathIn(rest);

  const entry: { kind: TaskActivityInput['kind']; title: string } = /^(read|open|view)/.test(verb)
    ? { kind: 'read', title: 'Read' }
    : /^list/.test(verb)
      ? { kind: 'read', title: 'List' }
      : /^(creat|add|writ|wrote)/.test(verb)
        ? { kind: 'create', title: 'Create' }
        : /^(delet|remov)/.test(verb)
          ? { kind: 'edit', title: 'Delete' }
          : /^(search|grep|glob)/.test(verb)
            ? { kind: 'search', title: searchTitle(text) }
            : { kind: 'edit', title: 'Edit' };

  // "Writing" with nothing that looks like a path is an agent describing its
  // intent, not a file landing on disk. Left as a status line so the drawer
  // does not claim a write it cannot point at.
  if (!path && entry.kind !== 'search') {
    return { kind: 'status', title: statusTitle(text), detail: text };
  }

  return { kind: entry.kind, title: entry.title, ...(path ? { file: path } : {}), detail: text };
}

/**
 * The first thing in a string that looks like a path this repository holds.
 *
 * Requires either a separator or a file extension, so a bare English word in a
 * sentence is never mistaken for a file and linked to nothing.
 */
function pathIn(text: string): string | undefined {
  const cleaned = text.replace(/^["'`]|["'`]$/g, '');
  const match =
    /(?:^|[\s"'`(=])((?:\.{0,2}\/)?[\w.@-]+(?:\/[\w.@-]+)+(?:\.[A-Za-z0-9]+)?|[\w.@-]+\.[A-Za-z][A-Za-z0-9]{0,5})(?=$|[\s"'`,);:])/.exec(
      cleaned,
    );
  if (!match) return undefined;

  const path = match[1]!.replace(/^\.\//, '');
  // A version range or a bare package spec is not somewhere to click through to.
  if (/^\d+\.\d/.test(path)) return undefined;
  return path;
}

/**
 * Terminal control sequences, which are formatting rather than content.
 *
 * Anchored on the escape character rather than on the bracket alone: an
 * unanchored `[…]` pattern also eats prose like "[1] see below", and the panel
 * would then be quietly rewriting what the agent said.
 */
export function stripAnsi(text: string): string {
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
