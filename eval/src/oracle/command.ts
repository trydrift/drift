/**
 * How an oracle command becomes a process.
 *
 * `command.split(/\s+/)` was enough for a corpus of five synthetic npm cases,
 * whose oracles are all `npm test` and `npx tsc --noEmit`. It is not enough for
 * anything real. External corpora state commands with quoted arguments
 * (`node -e "…"`), with pipes (`… | tee build.log`), with sequences
 * (`mvn -B clean && mvn -B test`) and with redirection. Splitting those on
 * whitespace does not fail loudly — it runs the wrong process with the wrong
 * arguments, or spawns `mvn` with a literal `&&` argv entry, and the resulting
 * non-zero exit is then recorded as a product result about Drift.
 *
 * Two execution shapes, chosen from the command's own text and *recorded* in
 * the parse so a report can say which one ran:
 *
 *   `argv`  — no shell metacharacters. Tokenised here, honouring POSIX-style
 *             quoting, and spawned with `execFile`. No shell is involved, so
 *             nothing in the command text can be reinterpreted.
 *   `shell` — the command genuinely needs a shell, because it contains an
 *             operator only a shell implements. Passed to `/bin/sh -c` (or
 *             `cmd.exe` on Windows) whole.
 *
 * The distinction is deliberate rather than a convenience. Sending everything
 * through a shell would be simpler and would silently change what a case's
 * command means — a filename with a space, a `$` in an argument — so a command
 * that does not need one does not get one.
 */

/** Characters that only a shell implements. Their presence is what selects the shell path. */
const SHELL_OPERATORS = /[|&;<>()$`\n*?[\]{}~!#]/;

export type ParsedCommand =
  | { kind: 'argv'; program: string; args: string[]; needsShell: false }
  | { kind: 'shell'; command: string; needsShell: true };

/** Why a command could not be turned into a process at all. */
export class CommandParseError extends Error {}

export function parseCommand(command: string): ParsedCommand {
  const trimmed = command.trim();
  if (trimmed.length === 0) throw new CommandParseError('the command is empty');

  if (SHELL_OPERATORS.test(stripQuoted(trimmed))) {
    return { kind: 'shell', command: trimmed, needsShell: true };
  }

  const tokens = tokenize(trimmed);
  const [program, ...args] = tokens;
  if (!program) throw new CommandParseError(`the command "${command}" has no program to run`);
  return { kind: 'argv', program, args, needsShell: false };
}

/**
 * The command with quoted regions blanked out, for operator detection only.
 *
 * `node -e "a && b"` contains `&&` inside a quoted argument and must *not*
 * become a shell command: the `&&` is data the program receives, not an
 * operator. Detecting operators on the raw text would send it to a shell,
 * where it would then be an operator.
 */
function stripQuoted(command: string): string {
  let out = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote) {
      if (char === '\\' && quote === '"') {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * POSIX-ish word splitting: whitespace separates, single quotes are literal,
 * double quotes allow backslash escapes, and a backslash outside quotes escapes
 * the next character. No expansion of any kind — a `$` or a glob reaches this
 * function only when it is inside quotes, because an unquoted one selected the
 * shell path above.
 */
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;

    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }

    if (quote === '"') {
      if (char === '\\') {
        const next = command[index + 1];
        // Only these are special inside double quotes; a backslash before
        // anything else is a literal backslash, as a shell would read it.
        if (next !== undefined && ['"', '\\', '$', '`'].includes(next)) {
          current += next;
          index += 1;
        } else {
          current += char;
        }
        continue;
      }
      if (char === '"') quote = null;
      else current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (char === '\\') {
      const next = command[index + 1];
      if (next === undefined) throw new CommandParseError(`the command "${command}" ends in a trailing backslash`);
      current += next;
      index += 1;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
    started = true;
  }

  if (quote) throw new CommandParseError(`the command "${command}" has an unterminated ${quote === '"' ? 'double' : 'single'} quote`);
  if (started) tokens.push(current);
  return tokens;
}
