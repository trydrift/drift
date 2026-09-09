/**
 * Structured diagnostics from a compiler or build tool's output, and the
 * subtraction that keeps only the ones a dependency change introduced.
 *
 * `filesNamedIn` (in `upgrade-probe.ts`) already pulls file paths out of the
 * same text, but it throws away the line, the column, and the message — enough
 * to say "something in this file broke", not enough to point at it. A
 * verification failure is the strongest evidence Drift has that a repository is
 * affected; when its output names a consumer location, that location should
 * become an {@link ImpactSite}, not a filename in a list.
 *
 * The parser is deliberately format-driven rather than ecosystem-driven: a
 * `tsc` line and a `javac`/Maven line look different, but a run can print
 * both (a polyglot repo, a build that shells out), and keying on the shape of
 * the line rather than on which tool we think we invoked is what survives that.
 */

/** One diagnostic, normalised across toolchains. */
export interface VerificationDiagnostic {
  /** Repo-relative where it could be made so; otherwise whatever the tool printed. */
  file: string;
  /** 1-indexed. */
  line: number;
  /** 0-indexed, when the tool gave a column. */
  column?: number;
  /** The tool's own code — `TS2345`, `error: cannot find symbol` has none. */
  code?: string;
  /** The message text, trimmed and capped. */
  message: string;
  severity: 'error' | 'warning';
  /**
   * Set when this came from a JVM stack frame rather than a `file:line:`
   * diagnostic.
   *
   * A frame prints only a basename, so `file` here is the package path the
   * class implies (`com/example/FooTest.java`) and not a path any tool
   * actually printed. Callers must resolve it against the repository before
   * showing it to anyone — see `measuredSitesFrom` in `analysis.ts`, which
   * drops the diagnostic when no such file exists rather than pointing a
   * reader at a path that was inferred.
   */
  origin?: 'stack-frame';
}

const MESSAGE_CAP = 300;

/**
 * TypeScript, both `tsc` layouts:
 *   src/x.ts(42,18): error TS2345: Argument of type ...
 *   src/x.ts:42:18 - error TS2345: Argument of type ...
 */
const TS_LINE = /^\s*(?:\x1b\[[0-9;]*m)*([^\s()][^()]*?)(?:\((\d+),(\d+)\)|:(\d+):(\d+))\s*[-:]?\s*(error|warning)\s+(TS\d+)\s*:\s*(.*)$/i;

/**
 * javac / Maven compiler plugin:
 *   /abs/Foo.java:[42,13] cannot find symbol
 *   [ERROR] /abs/Foo.java:[42,13] method x in class Y cannot be applied ...
 *   Foo.java:42: error: incompatible types
 */
const JAVAC_BRACKET = /^\s*(?:\[(?:ERROR|WARNING)\]\s*)?(\/?[^\s:]+\.(?:java|kt|scala)):\[(\d+),(\d+)\]\s*(.*)$/;
const JAVAC_COLON = /^\s*(?:\[(?:ERROR|WARNING)\]\s*)?(\/?[^\s:]+\.(?:java|kt|scala)):(\d+):\s*(error|warning)\s*:\s*(.*)$/i;

/** Last-resort generic `path:line:col: message` / `path:line: message`. */
const GENERIC = /^\s*([^\s:][^:]*\.\w+):(\d+)(?::(\d+))?:\s*(.*)$/;

/**
 * A Maven Surefire / Failsafe failure header, both layouts it has shipped:
 *
 *   [ERROR] testFoo(com.example.FooTest)  Time elapsed: 0.01 s  <<< FAILURE!
 *   [ERROR] com.example.FooTest.testFoo  Time elapsed: 0.01 s  <<< ERROR!
 */
const SUREFIRE_HEADER =
  /^\s*(?:\[ERROR\]\s*)?(?:(\w+)\((\S+?)\)|([\w.$]+)\.(\w+))\s+Time elapsed:.*<<<\s*(FAILURE|ERROR)!/;

/** A JVM stack frame: `\tat com.example.FooTest.testFoo(FooTest.java:42)`. */
const STACK_FRAME = /^\s*at\s+([\w.$]+)\.[\w$<>]+\((\w[\w$]*\.(?:java|kt|scala)):(\d+)\)/;

/**
 * Frames reported per failing test.
 *
 * The frame that matches the test class is the one a developer opens; deeper
 * matches are the same test's helpers and worth keeping, but a long recursive
 * trace should not become fifty impact sites for one failure.
 */
const MAX_FRAMES_PER_FAILURE = 3;

function clean(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*m/g, '')
    .trim()
    .slice(0, MESSAGE_CAP);
}

function normalizePath(raw: string, root?: string): string {
  let path = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  if (root) {
    const base = root.replace(/\\/g, '/').replace(/\/+$/, '');
    if (path === base) return path;
    if (path.startsWith(`${base}/`)) path = path.slice(base.length + 1);
  }
  return path;
}

/**
 * Parse every diagnostic line a compiler/build tool printed. Order-preserving,
 * de-duplicated.
 *
 * `root` — the checkout the checks ran in — is stripped from any absolute path
 * that lies under it, so a Maven `[ERROR] /var/.../worktree-abc/src/Foo.java`
 * comes back as `src/Foo.java`, the same shape `tsc` already prints and the
 * shape an {@link ImpactSite} needs.
 */
export function parseVerificationDiagnostics(output: string, root?: string): VerificationDiagnostic[] {
  const found: VerificationDiagnostic[] = [];
  const seen = new Set<string>();

  const push = (diagnostic: VerificationDiagnostic): void => {
    const key = `${diagnostic.file}|${diagnostic.line}|${diagnostic.column ?? ''}|${diagnostic.code ?? ''}|${diagnostic.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(diagnostic);
  };

  /**
   * The failing test whose stack trace is currently being read.
   *
   * A test failure names its location in a stack frame rather than in a
   * `file:line:` diagnostic, so it needs the header for context: the frames
   * worth reporting are the ones belonging to the class the header named, and
   * everything below them is JUnit, Surefire and the JDK.
   */
  let failure: { testClass: string; testName: string; message: string | null; frames: number } | null = null;

  for (const rawLineWithAnsi of output.split('\n')) {
    // Strip ANSI once, up front: `tsc --pretty` and Maven colour output wrap
    // the filename, the line number and the severity word individually, and a
    // regex that tries to tolerate escape codes between every token is
    // unreadable and still misses cases.
    const rawLine = rawLineWithAnsi.replace(/\x1b\[[0-9;]*m/g, '');

    const header = SUREFIRE_HEADER.exec(rawLine);
    if (header) {
      // Layout one puts the method first (`testFoo(com.example.FooTest)`),
      // layout two puts it last (`com.example.FooTest.testFoo`).
      failure = {
        testClass: header[2] ?? header[3]!,
        testName: header[1] ?? header[4]!,
        message: null,
        frames: 0,
      };
      continue;
    }

    if (failure) {
      const frame = STACK_FRAME.exec(rawLine);
      if (frame) {
        // Only the frames inside the class the header named. A stack trace is
        // mostly JUnit, Surefire and JDK internals, and pointing a developer at
        // `ReflectiveMethodInvocation.java:186` is worse than pointing nowhere.
        const frameClass = frame[1]!;
        const owner = frameClass.split('$')[0]!;
        if (owner === failure.testClass.split('$')[0] && failure.frames < MAX_FRAMES_PER_FAILURE) {
          failure.frames++;
          // The frame prints only the basename; the class's package is what
          // turns it into a path. `resolveAgainstRepository` matches the
          // result by suffix against files that actually exist, so a source
          // root of `src/test/java` never has to be guessed at here.
          const packagePath = owner.includes('.')
            ? `${owner.slice(0, owner.lastIndexOf('.')).replace(/\./g, '/')}/`
            : '';
          push({
            file: `${packagePath}${frame[2]!}`,
            line: Number(frame[3]),
            message: clean(failure.message ?? `${failure.testName} failed`),
            severity: 'error',
            origin: 'stack-frame',
          });
        }
        continue;
      }
      // The exception line sits between the header and the first frame.
      if (failure.message === null && rawLine.trim().length > 0) failure.message = clean(rawLine);
    }

    const ts = TS_LINE.exec(rawLine);
    if (ts) {
      const line = Number(ts[2] ?? ts[4]);
      const column = Number(ts[3] ?? ts[5]);
      push({
        file: normalizePath(ts[1]!, root),
        line,
        ...(Number.isFinite(column) && column > 0 ? { column: column - 1 } : {}),
        code: ts[7]!.toUpperCase(),
        message: clean(ts[8] ?? ''),
        severity: (ts[6] ?? 'error').toLowerCase() === 'warning' ? 'warning' : 'error',
      });
      continue;
    }

    const bracket = JAVAC_BRACKET.exec(rawLine);
    if (bracket) {
      const column = Number(bracket[3]);
      push({
        file: normalizePath(bracket[1]!, root),
        line: Number(bracket[2]),
        ...(Number.isFinite(column) && column > 0 ? { column: column - 1 } : {}),
        message: clean(bracket[4] ?? ''),
        severity: /^\s*\[WARNING\]/.test(rawLine) ? 'warning' : 'error',
      });
      continue;
    }

    const colon = JAVAC_COLON.exec(rawLine);
    if (colon) {
      push({
        file: normalizePath(colon[1]!, root),
        line: Number(colon[2]),
        message: clean(colon[4] ?? ''),
        severity: (colon[3] ?? 'error').toLowerCase() === 'warning' ? 'warning' : 'error',
      });
      continue;
    }

    const generic = GENERIC.exec(rawLine);
    if (generic) {
      const column = Number(generic[3]);
      const message = clean(generic[4] ?? '');
      // A bare `foo.json:1:1` with no message is noise, not a diagnostic.
      if (message.length === 0) continue;
      push({
        file: normalizePath(generic[1]!, root),
        line: Number(generic[2]),
        ...(Number.isFinite(column) && column > 0 ? { column: column - 1 } : {}),
        message,
        severity: /warning/i.test(message) ? 'warning' : 'error',
      });
    }
  }

  return found;
}

/**
 * The identity a diagnostic keeps across an unrelated edit.
 *
 * Deliberately **not** the line number: a dependency bump that adds an import
 * shifts every line below it, and a baseline diagnostic that reappears two
 * lines down is the same pre-existing problem, not a new one. File, code, and
 * the message's stable head are what a human uses to say "that's the same
 * error"; the message is truncated hard because tools splice type names and
 * paths into it that differ run to run.
 */
function identity(diagnostic: VerificationDiagnostic): string {
  const head = diagnostic.message.toLowerCase().replace(/['"`].*?['"`]/g, '‹›').replace(/\s+/g, ' ').slice(0, 80);
  return `${diagnostic.file}|${diagnostic.code ?? ''}|${head}`;
}

/**
 * Error diagnostics in `after` whose {@link identity} is not in `before`.
 *
 * Subtracted by identity, not by exact match, so a pre-existing error that
 * merely moved down a few lines is not reported as introduced. An empty
 * `before` returns every error in `after` — correct when the baseline check
 * passed and therefore emitted none.
 */
export function subtractBaseline(
  after: readonly VerificationDiagnostic[],
  before: readonly VerificationDiagnostic[],
): VerificationDiagnostic[] {
  const baseline = new Set(before.map(identity));
  return after.filter((diagnostic) => diagnostic.severity === 'error' && !baseline.has(identity(diagnostic)));
}
