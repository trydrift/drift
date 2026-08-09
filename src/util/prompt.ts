/**
 * Minimal, dependency-free terminal prompts shared by every CLI command that
 * asks a human a yes/no or pick-one question. TTY-gated: piped/CI input never
 * blocks, it just falls back to the caller-supplied default.
 */

export async function ask(question: string, options: string[], fallback = options[options.length - 1]!): Promise<string> {
  if (!process.stdin.isTTY) return fallback;

  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\n${question}`);
    options.forEach((option, index) => console.log(`  [${index + 1}] ${option}`));
    const answer = await rl.question('> ');
    const index = Number.parseInt(answer.trim(), 10);
    return Number.isInteger(index) && options[index - 1] ? options[index - 1]! : fallback;
  } finally {
    rl.close();
  }
}

/** `[y/N]`-style confirmation. Anything but an explicit "y"/"yes" is "no". */
export async function confirm(question: string, defaultAnswer = false): Promise<boolean> {
  if (!process.stdin.isTTY) return defaultAnswer;

  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const hint = defaultAnswer ? 'Y/n' : 'y/N';
    const answer = (await rl.question(`${question} [${hint}] `)).trim().toLowerCase();
    if (answer === '') return defaultAnswer;
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}
