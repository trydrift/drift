import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AgentStreamReader, execActivity, unwrapShell } from '../src/agents/stream.js';
import { agentConclusion } from '../src/agents/cli.js';

/**
 * Reading an agent's stream as the blocks it was written as.
 *
 * The transcript below is a real `codex exec` run, copied verbatim from a
 * capture rather than written from memory — the whole failure this replaces
 * came from guessing at the shape of this output instead of looking at it.
 *
 * Read line by line, it produced thirteen rows: one titled `exec`, one titled
 * `codex`, one containing `}`, one containing `4,842`. None of them named
 * anything a developer could act on, and the agent's actual answer was split
 * across several of them. Read as blocks it is four events: a command, what it
 * printed, a second command, and the conclusion.
 */
const CODEX_TRANSCRIPT = `Reading prompt from stdin...
OpenAI Codex v0.147.0
--------
workdir: /repo
model: gpt-5.5
provider: openai
approval: never
sandbox: read-only
reasoning effort: medium
session id: 019ffd79-b258-7e83-8178-ef5e00e63312
--------
user
Read a.js and tell me what it does.

thinking
**Checking the installed exports**

The code imports only the \`z\` namespace and calls \`z.object\`; there is no
direct \`object\` import in either allowed file.

exec
/bin/zsh -lc "sed -n '1,200p' a.js" in /repo
 succeeded in 5066ms:
export function greet(name){
  return "hi " + name;
}

codex
\`a.js\` exports a \`greet(name)\` function that returns the string "hi "
followed by the provided name.
tokens used
4,842
`;

function read(text: string) {
  const reader = new AgentStreamReader();
  const events = [...reader.push(text), ...reader.flush()];
  return { events, reader };
}

describe('reading a block-structured agent stream', () => {
  test('the CLI introducing itself is not work it did', () => {
    const { events } = read(CODEX_TRANSCRIPT);

    for (const event of events) {
      const text = `${event.title} ${event.detail ?? ''}`;
      assert.ok(!/OpenAI Codex v|session id|sandbox: read-only/.test(text), `banner leaked: ${text}`);
    }
  });

  test('a block keyword never becomes a row of its own', () => {
    const { events } = read(CODEX_TRANSCRIPT);

    for (const event of events) {
      assert.ok(
        !['exec', 'codex', 'thinking', 'tokens used', 'user'].includes((event.detail ?? '').trim()),
        `"${event.detail}" is a block header, not an event`,
      );
    }
  });

  test('the prompt Drift wrote and the token count are not events', () => {
    const { events } = read(CODEX_TRANSCRIPT);

    assert.ok(!events.some((e) => (e.detail ?? '').includes('Read a.js and tell me')), 'our own prompt read back');
    assert.ok(!events.some((e) => (e.detail ?? '').includes('4,842')), 'billing is not work');
  });

  test('a command and its output are one event, not five', () => {
    const { events } = read(CODEX_TRANSCRIPT);
    const command = events.find((e) => e.input?.includes('sed'));

    assert.ok(command, 'the command is reported');
    assert.equal(command!.kind, 'read', 'sed -n on one file is Codex reading it');
    assert.equal(command!.file, 'a.js');
    assert.ok(command!.output?.includes('return "hi " + name;'), 'its output belongs under it');
    assert.ok(!command!.output?.includes('succeeded in'), 'the timing line is chrome');
  });

  test('reasoning is titled with the heading the model wrote for it', () => {
    const { events } = read(CODEX_TRANSCRIPT);
    const thought = events.find((e) => e.title === 'Checking the installed exports');

    assert.ok(thought, 'the model wrote a one-line summary; it is better than any we could derive');
    assert.equal(thought!.kind, 'thinking');
    assert.ok(thought!.detail?.includes('imports only'), 'the paragraph stays with its heading');
    assert.ok(!thought!.detail?.startsWith('**'), 'and stops being stray markdown inside the prose');
  });

  test("the agent's answer arrives whole", () => {
    const { events } = read(CODEX_TRANSCRIPT);
    const answer = events.find((e) => e.title === 'Response');

    assert.ok(answer, 'the conclusion is an event');
    assert.ok(answer!.detail?.includes('greet(name)'), 'in one piece, not split at newlines');
  });

  test('a chunk boundary in the middle of a block changes nothing', () => {
    const whole = read(CODEX_TRANSCRIPT).events;

    const reader = new AgentStreamReader();
    const split: unknown[] = [];
    for (let i = 0; i < CODEX_TRANSCRIPT.length; i += 7) {
      split.push(...reader.push(CODEX_TRANSCRIPT.slice(i, i + 7)));
    }
    split.push(...reader.flush());

    assert.deepEqual(split, whole, 'pipe buffering is not a fact about the agent');
  });

  test('an agent with no block structure still gets a row per line', () => {
    const { events } = read('Considering whether the factory helper covers this call site\n');

    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, 'thinking');
  });
});

describe('naming what a command actually did', () => {
  test('a shell wrapper is not the command', () => {
    assert.equal(unwrapShell(`/bin/zsh -lc "rg --files -g 'a.js'"`), `rg --files -g 'a.js'`);
    assert.equal(unwrapShell(`bash -lc 'npm test'`), 'npm test');
  });

  test('a payload that cannot be read back intact is left as printed', () => {
    // Rewriting a command Drift claims to be showing is worse than showing a
    // wrapper: the reader would be reading something the agent never ran.
    const nested = `/bin/zsh -lc "echo \\"a\\" && echo "b""`;
    assert.equal(unwrapShell(nested), nested);
  });

  test('a plain command is left alone', () => {
    assert.equal(unwrapShell('npm run typecheck'), 'npm run typecheck');
  });

  test('searching, listing and verifying are told apart', () => {
    assert.equal(execActivity(`/bin/zsh -lc "rg z.object src" in /repo`).title, 'Search');
    assert.equal(execActivity(`/bin/zsh -lc "ls src" in /repo`).title, 'List');
    assert.equal(execActivity(`/bin/zsh -lc "npm run typecheck" in /repo`).title, 'Verify');
    assert.equal(execActivity(`/bin/zsh -lc "node scripts/thing.mjs" in /repo`).title, 'Bash');
  });

  test('a failed command says so in its title', () => {
    const activity = execActivity(`/bin/zsh -lc "npm test" in /repo\n failed in 900ms:\n1 failing`);
    assert.match(activity.title, /failed/);
  });

  test('the workspace path is not repeated on every row', () => {
    assert.equal(execActivity(`/bin/zsh -lc "ls" in /some/long/workspace/path`).input, 'ls');
  });
});

/**
 * The complaint that started this: a run ended "No change needed" and never
 * said why, while the agent's own three-sentence explanation — which was
 * correct — went to stdout and was discarded in favour of "Codex finished."
 */
describe("reporting what the agent concluded", () => {
  test("the agent's answer is the result, not the fact that it exited", () => {
    const conclusion = agentConclusion(
      'No code changes were made. Both files use `z.object` via the namespace import, which zod 4 still exports.\n',
      '',
    );

    assert.match(conclusion ?? '', /zod 4 still exports/);
  });

  test('a transcript on one pipe is still read for the last thing said', () => {
    const conclusion = agentConclusion('', CODEX_TRANSCRIPT);
    assert.match(conclusion ?? '', /greet\(name\)/);
  });

  test('a machine envelope is not quoted as if the agent said it', () => {
    assert.equal(agentConclusion('{"error":{"message":"bad request"}}', ''), undefined);
    assert.equal(agentConclusion('TypeError: x\n    at run (/a/b.js:1:1)', ''), undefined);
  });

  test('an agent that said nothing gets no invented conclusion', () => {
    assert.equal(agentConclusion('   \n', ''), undefined);
  });
});
