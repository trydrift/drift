import { guardDecision } from './verification-guard.js';

// Entry point for the PreToolUse hook: the tool call arrives on stdin; exit 2
// refuses it and hands stderr to the model.
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => (input += chunk));
process.stdin.on('end', () => {
  const decision = guardDecision(input);
  if (decision.block) {
    process.stderr.write(decision.reason);
    process.exit(2);
  }
  process.exit(0);
});
