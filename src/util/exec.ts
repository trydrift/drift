import { execFile } from 'node:child_process';

/**
 * Running local tools.
 *
 * Drift shells out to whatever an ecosystem's own API-diffing tool is, because
 * reimplementing rustdoc or the Java classfile format badly is worse evidence
 * than none. That makes "the tool is not installed" an ordinary outcome rather
 * than an error, so nothing here throws: a missing binary is a exit code like
 * any other, and the caller turns it into a stated reason.
 *
 * Arguments are always argv. No string is ever handed to a shell.
 */

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Set when the process could not be started or was killed. */
  failure?: 'not-found' | 'timeout' | 'error';
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  /**
   * Called with each chunk the command prints, as it prints it.
   *
   * The buffered `stdout`/`stderr` on the result are still the record; this is
   * for surfaces that have someone watching. A `npm install` or a `tsc -b` on a
   * large repository is minutes of a developer staring at a spinner that cannot
   * distinguish "compiling" from "hung", and the tool was printing the
   * difference the whole time — there was simply nowhere for it to go.
   *
   * Never trusted to arrive on line boundaries: a chunk is whatever the pipe
   * delivered, so a consumer that wants lines has to buffer them itself.
   */
  onOutput?: (chunk: string) => void;
}

export type Exec = (
  command: string,
  args: readonly string[],
  options?: ExecOptions,
) => Promise<CommandResult>;

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;

export const execCommand: Exec = (command, args, options = {}) =>
  new Promise((resolve) => {
    const child = execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
        env: options.env ?? process.env,
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr });
          return;
        }

        const err = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
        resolve({
          code: typeof err.code === 'number' ? err.code : 1,
          stdout: stdout ?? '',
          stderr: stderr ?? String(error.message ?? ''),
          failure: err.code === 'ENOENT' ? 'not-found' : err.killed ? 'timeout' : 'error',
        });
      },
    );
    // Reading the pipes in addition to `execFile`'s own buffering, not instead
    // of it: the callback above still receives the complete output, and this
    // only mirrors it somewhere a progress display can use while the command
    // is still running.
    if (options.onOutput) {
      const forward = (chunk: unknown) => {
        try {
          options.onOutput!(String(chunk));
        } catch {
          // A progress renderer that throws must not take down the command it
          // is reporting on.
        }
      };
      child.stdout?.on('data', forward);
      child.stderr?.on('data', forward);
    }

    // Nothing here ever has input to give an interactive prompt. Left open,
    // an unattended pipe leaves a tool that stops to ask something (a package
    // manager's "already installed, overwrite?") blocked forever instead of
    // failing fast, since there is never a human at the other end to answer.
    child.stdin?.end();
  });

/** Is this tool on the PATH and runnable? */
export async function isAvailable(
  exec: Exec,
  command: string,
  args: readonly string[] = ['--version'],
): Promise<boolean> {
  const result = await exec(command, args, { timeoutMs: 20_000 });
  return result.failure !== 'not-found' && result.code === 0;
}
