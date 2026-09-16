import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The project's ESLint configuration, exercised rather than inspected: with
// fixture files placed where the project lints its own sources, the rules the
// configuration is supposed to enforce must still fire, and clean code must
// still pass. Whether the configuration is an .eslintrc or a flat config is
// not this check's business; only what running the linter does.
const dir = join('src', '__drift_hidden_lint__');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const fixtures = {
  'unused.ts': `export function keep(): number {\n  const unusedValue = 42;\n  return 1;\n}\n`,
  'child-process.ts': `const cp = require('child_process');\nexport function run(cmd: string): void {\n  cp.exec(cmd);\n}\n`,
  'unsafe-execa.ts': `import { execa } from 'execa';\nexport async function run(name: string): Promise<void> {\n  await execa(\`docker rm \${name}\`);\n}\n`,
  'clean.ts': `export function add(a: number, b: number): number {\n  return a + b;\n}\n`,
};
for (const [name, content] of Object.entries(fixtures)) writeFileSync(join(dir, name), content);

const failures = [];
try {
  // Written to a file rather than read from stdout: a configuration that
  // loads rule files at require time can print to stdout before the report.
  const out = join(dir, 'report.json');
  const result = spawnSync('npx', ['eslint', '--format', 'json', '-o', out, '--no-error-on-unmatched-pattern', dir], { encoding: 'utf8', timeout: 300_000 });
  let report;
  try {
    report = JSON.parse(readFileSync(out, 'utf8'));
  } catch {
    failures.push(`eslint produced no JSON report (exit ${result.status}): ${(result.stdout + result.stderr).slice(0, 1500)}`);
    report = [];
  }
  const byFile = new Map(report.filter((entry) => !entry.filePath.endsWith('report.json')).map((entry) => [entry.filePath.split('/').pop(), entry.messages]));
  const messages = (name) => byFile.get(name) ?? [];
  const has = (name, predicate) => messages(name).some(predicate);

  if (!has('unused.ts', (m) => m.ruleId === '@typescript-eslint/no-unused-vars' && m.severity === 2)) {
    failures.push(`@typescript-eslint/no-unused-vars did not report an error on unused.ts: ${JSON.stringify(messages('unused.ts')).slice(0, 500)}`);
  }
  if (!has('child-process.ts', (m) => m.ruleId === 'security/detect-child-process' && m.severity === 2)) {
    failures.push(`security/detect-child-process did not report an error on child-process.ts: ${JSON.stringify(messages('child-process.ts')).slice(0, 500)}`);
  }
  if (!has('unsafe-execa.ts', (m) => /execa/u.test(m.ruleId ?? '') && /command injection/u.test(m.message))) {
    failures.push(`the project's own no-unsafe-execa rule did not fire on unsafe-execa.ts: ${JSON.stringify(messages('unsafe-execa.ts')).slice(0, 500)}`);
  }
  const cleanErrors = messages('clean.ts').filter((m) => m.severity === 2);
  if (cleanErrors.length > 0) failures.push(`clean.ts was reported with errors: ${JSON.stringify(cleanErrors).slice(0, 500)}`);
  if (report.filter((entry) => !entry.filePath.endsWith('report.json')).length < 4) failures.push(`expected 4 fixture files in the report, got ${report.length} (the fixtures directory may be ignored by the configuration)`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`lint configuration behaviour: ${failures.length} failure(s)\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('lint configuration behaviour: ok');
