import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Exercises the logger module's observable behaviour through its compiled
// entry point, in child processes so console output can be captured whole.
// Nothing here depends on how the module is written: only on what the
// repository's own code exports and does.
// The upgrade breaks this module at the type level first: tsc still emits
// JavaScript for a file with type errors, so behaviour alone cannot tell the
// unmigrated module from a migrated one. A correct migration typechecks.
const typecheck = spawnSync('npx', ['tsc', '--noEmit', '-p', 'tsconfig.json'], { encoding: 'utf8', timeout: 300_000 });
if (typecheck.status !== 0) {
  console.error(`the project does not typecheck:\n${(typecheck.stdout + typecheck.stderr).slice(0, 2000)}`);
  process.exit(1);
}

const loggerPath = resolve('dist/lib/logger.js');
if (!existsSync(loggerPath)) {
  console.error(`missing ${loggerPath}; the project must compile before behaviour can be checked`);
  process.exit(1);
}

function runInChild(script, cwd, env = {}) {
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { code: result.status, out: `${result.stdout}\n${result.stderr}` };
}

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

// 1. Console: errors are printed, info is not until the console level is raised.
{
  const dir = mkdtempSync(join(tmpdir(), 'winston-hidden-'));
  const script = `
    const { logger, changeConsoleLevel } = require(${JSON.stringify(loggerPath)});
    logger.error('HIDDEN-ERR-ONE');
    logger.info('HIDDEN-INFO-ONE');
    changeConsoleLevel('info');
    logger.info('HIDDEN-INFO-TWO');
    logger.error('HIDDEN-ERR-TWO');
    setTimeout(() => process.exit(0), 700);
  `;
  const { code, out } = runInChild(script, dir, { AWS_LAMBDA_FUNCTION_NAME: 'hidden-check' });
  check(code === 0, `console scenario exited ${code}: ${out.slice(0, 500)}`);
  check(out.includes('HIDDEN-ERR-ONE'), `an error logged at the default level was not printed: ${out.slice(0, 500)}`);
  check(!out.includes('HIDDEN-INFO-ONE'), `an info message was printed while the console level was error: ${out.slice(0, 500)}`);
  check(out.includes('HIDDEN-INFO-TWO'), `an info message was not printed after changeConsoleLevel('info'): ${out.slice(0, 500)}`);
  check(out.includes('HIDDEN-ERR-TWO'), `an error was not printed after changeConsoleLevel('info'): ${out.slice(0, 500)}`);
  check(!existsSync(join(dir, 'xray-scan.log')), 'a log file was written although AWS_LAMBDA_FUNCTION_NAME was set');
}

// 2. File: outside Lambda, debug-level messages land in xray-scan.log even though the console stays at error.
{
  const dir = mkdtempSync(join(tmpdir(), 'winston-hidden-'));
  const script = `
    const { logger } = require(${JSON.stringify(loggerPath)});
    logger.debug('HIDDEN-DEBUG-FILE');
    logger.error('HIDDEN-ERR-FILE');
    setTimeout(() => process.exit(0), 700);
  `;
  const env = { ...process.env };
  delete env.AWS_LAMBDA_FUNCTION_NAME;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: dir, env, encoding: 'utf8', timeout: 30_000 });
  const out = `${result.stdout}\n${result.stderr}`;
  check(result.status === 0, `file scenario exited ${result.status}: ${out.slice(0, 500)}`);
  const logFile = join(dir, 'xray-scan.log');
  check(existsSync(logFile), 'xray-scan.log was not written outside Lambda');
  const content = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
  check(content.includes('HIDDEN-DEBUG-FILE'), `a debug message did not reach xray-scan.log: ${content.slice(0, 300)}`);
  check(content.includes('HIDDEN-ERR-FILE'), `an error message did not reach xray-scan.log: ${content.slice(0, 300)}`);
  check(!out.includes('HIDDEN-DEBUG-FILE'), `a debug message reached the console at the default level: ${out.slice(0, 300)}`);
}

if (failures.length > 0) {
  console.error(`logger behaviour: ${failures.length} failure(s)\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('logger behaviour: ok');
