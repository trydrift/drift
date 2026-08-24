from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, found {count}")
    p.write_text(text.replace(old, new, 1))


# Preserve PR #86's diagnostic measurements/rendering. Only change artifact identity/lifecycle.
replace_once(
    "src/util/diagnostics.ts",
    " * A single always-on, repo-local diagnostic run log.\n",
    " * Always-on, repo-local diagnostic run logging.\n",
)
replace_once(
    "src/util/diagnostics.ts",
    " * Written to `<repo git dir>/drift/run.log`. Only the most recent *completed*\n * run is kept.\n",
    " * Typed runs are written as immutable artifacts under `<repo git dir>/drift/`:\n * `run-<type>-<started-at>-<run-id>.log`. Following a worktree's `.git`\n * pointer keeps each linked worktree's history independent.\n",
)
replace_once(
    "src/util/diagnostics.ts",
    " *  - A repo-local ownership marker prevents an older overlapping process from\n *    overwriting a newer run's report.\n",
    " *  - Each typed run owns a unique final path and crash marker, so overlapping\n *    runs never overwrite, suppress, or clean up one another.\n",
)
replace_once(
    "src/util/diagnostics.ts",
    "interface Header {\n  runId: string;\n  command: string;\n  mode: string;\n",
    "interface Header {\n  runId: string;\n  command: string;\n  type?: string;\n  mode: string;\n",
)
replace_once(
    "src/util/diagnostics.ts",
    "class RunState {\n  readonly startedAtMs = Date.now();\n",
    "class RunState {\n  readonly startedAtMs: number;\n",
)
replace_once(
    "src/util/diagnostics.ts",
    """  constructor(
    readonly header: Header,
    readonly path: string | null,
    readonly gitDir: string,
    readonly owner: RunOwner,
  ) {}
""",
    """  constructor(
    readonly header: Header,
    readonly path: string | null,
    readonly gitDir: string,
    readonly owner: RunOwner,
    readonly markerPath: string | null,
    readonly legacySingleFile: boolean,
  ) {
    this.startedAtMs = owner.startedAtMs;
  }
""",
)
replace_once(
    "src/util/diagnostics.ts",
    "export interface StartRunOptions {\n  command: string;\n  mode: string;\n",
    "export interface StartRunOptions {\n  command: string;\n  type?: string;\n  mode: string;\n",
)
replace_once(
    "src/util/diagnostics.ts",
    "    `run_id: ${h.runId}`,\n    `command: ${h.command}`,\n    `mode: ${h.mode}`,\n",
    "    `run_id: ${h.runId}`,\n    `command: ${h.command}`,\n    ...(h.type ? [`type: ${h.type}`] : []),\n    `mode: ${h.mode}`,\n",
)

marker = "export function startRunLog(options: StartRunOptions): RunLogHandle {\n"
helpers = r"""function sanitizeRunType(type: string): string {
  const sanitized = type
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || 'run';
}

function runTimestamp(startedAtMs: number): string {
  return new Date(startedAtMs).toISOString().replace(/:/g, '-');
}

function inferredRunType(command: string, mode: string): string | null {
  const vscode = /^vscode:\s+drift\.([A-Za-z0-9_-]+)/.exec(command);
  if (vscode) return vscode[1] ?? null;

  const cli = /^drift\s+(analyze|analyse|outdated|fix|pr)\b/.exec(command);
  if (!cli) return null;

  const operation = cli[1] === 'analyse' ? 'analyze' : cli[1]!;
  if (operation === 'outdated') {
    const includeDev = !/(?:^|\s)--no-dev(?:\s|$)/.test(command);
    return `${includeDev ? 'dev' : 'runtime'}-${mode}`;
  }
  return `${operation}-${mode}`;
}

function runArtifactBase(type: string, owner: RunOwner): string {
  return `run-${sanitizeRunType(type)}-${runTimestamp(owner.startedAtMs)}-${owner.runId.slice(0, 8)}`;
}

"""
p = Path("src/util/diagnostics.ts")
text = p.read_text()
if text.count(marker) != 1:
    raise SystemExit("src/util/diagnostics.ts: startRunLog marker mismatch")
p.write_text(text.replace(marker, helpers + marker, 1))

old_start = r"""export function startRunLog(options: StartRunOptions): RunLogHandle {
  const owner: RunOwner = { runId: randomUUID(), startedAtMs: Date.now() };
  const header: Header = {
    runId: owner.runId,
    command: options.command,
    mode: options.mode,
    repoRoot: options.repoRoot,
    gitHead: options.gitHead ?? 'unknown',
    driftVersion: options.driftVersion ?? '0.0.0',
  };

  const gitDir = resolveGitDir(options.repoRoot);
  let dir: string | null = null;
  let path: string | null = null;
  try {
    dir = join(gitDir, 'drift');
    mkdirSync(dir, { recursive: true });
    path = join(dir, 'run.log');
    withRunLogLock(dir, () => {
      const markerTmp = join(dir!, `run.in-progress.${process.pid}.${owner.runId}.tmp`);
      writeFileSync(markerTmp, ownerText(owner, header), 'utf8');
      renameSync(markerTmp, join(dir!, 'run.in-progress'));
    });
  } catch {
    path = null;
  }

  const state = new RunState(header, path, gitDir, owner);
  return {
    path,
    run: (fn) => als.run({ state, parentId: null }, fn),
    finish(status, meta) {
      if (state.finished) return;
      state.finished = true;

      const now = state.now();
      for (const span of state.spans) {
        if (span.endMs === null) {
          span.endMs = now;
          span.status = 'interrupted';
        }
      }

      if (!state.path || !dir) return;
      try {
        const report = headerText(state.header, new Date(state.startedAtMs).toISOString()) + render(state, status, meta ?? {});
        const tmp = join(dir, `run.log.${process.pid}.${state.owner.runId}.tmp`);
        writeFileSync(tmp, report, 'utf8');
        withRunLogLock(dir, () => {
          const marker = join(dir!, 'run.in-progress');
          if (!sameOwner(readOwner(marker), state.owner)) {
            rmSync(tmp, { force: true });
            return;
          }
          renameSync(tmp, state.path!);
          rmSync(marker, { force: true });
        });
      } catch {
        // Diagnostics must never fail the operation being diagnosed.
      }
    },
  };
}
"""
new_start = r"""export function startRunLog(options: StartRunOptions): RunLogHandle {
  const owner: RunOwner = { runId: randomUUID(), startedAtMs: Date.now() };
  const type = options.type ?? inferredRunType(options.command, options.mode) ?? undefined;
  const header: Header = {
    runId: owner.runId,
    command: options.command,
    type: type ? sanitizeRunType(type) : undefined,
    mode: options.mode,
    repoRoot: options.repoRoot,
    gitHead: options.gitHead ?? 'unknown',
    driftVersion: options.driftVersion ?? '0.0.0',
  };

  const gitDir = resolveGitDir(options.repoRoot);
  let dir: string | null = null;
  let path: string | null = null;
  let markerPath: string | null = null;
  const legacySingleFile = !header.type;
  try {
    dir = join(gitDir, 'drift');
    mkdirSync(dir, { recursive: true });

    if (header.type) {
      const base = runArtifactBase(header.type, owner);
      path = join(dir, `${base}.log`);
      markerPath = join(dir, `${base}.in-progress`);
      const markerTmp = `${markerPath}.${process.pid}.tmp`;
      writeFileSync(markerTmp, ownerText(owner, header), 'utf8');
      renameSync(markerTmp, markerPath);
    } else {
      path = join(dir, 'run.log');
      markerPath = join(dir, 'run.in-progress');
      withRunLogLock(dir, () => {
        const markerTmp = join(dir!, `run.in-progress.${process.pid}.${owner.runId}.tmp`);
        writeFileSync(markerTmp, ownerText(owner, header), 'utf8');
        renameSync(markerTmp, markerPath!);
      });
    }
  } catch {
    path = null;
    markerPath = null;
  }

  const state = new RunState(header, path, gitDir, owner, markerPath, legacySingleFile);
  return {
    path,
    run: (fn) => als.run({ state, parentId: null }, fn),
    finish(status, meta) {
      if (state.finished) return;
      state.finished = true;

      const now = state.now();
      for (const span of state.spans) {
        if (span.endMs === null) {
          span.endMs = now;
          span.status = 'interrupted';
        }
      }

      if (!state.path || !dir) return;
      try {
        const report = headerText(state.header, new Date(state.startedAtMs).toISOString()) + render(state, status, meta ?? {});

        if (!state.legacySingleFile) {
          const tmp = `${state.path}.${process.pid}.tmp`;
          writeFileSync(tmp, report, 'utf8');
          renameSync(tmp, state.path);
          if (state.markerPath) rmSync(state.markerPath, { force: true });
          return;
        }

        const tmp = join(dir, `run.log.${process.pid}.${state.owner.runId}.tmp`);
        writeFileSync(tmp, report, 'utf8');
        withRunLogLock(dir, () => {
          const marker = join(dir!, 'run.in-progress');
          if (!sameOwner(readOwner(marker), state.owner)) {
            rmSync(tmp, { force: true });
            return;
          }
          renameSync(tmp, state.path!);
          rmSync(marker, { force: true });
        });
      } catch {
        // Diagnostics must never fail the operation being diagnosed.
      }
    },
  };
}
"""
replace_once("src/util/diagnostics.ts", old_start, new_start)

replace_once(
    "extension/src/run-diagnostics.ts",
    "    command: string;\n    mode: 'quick' | 'deep';\n",
    "    command: string;\n    type?: string;\n    mode: 'quick' | 'deep';\n",
)
replace_once(
    "extension/src/run-diagnostics.ts",
    "  const log = startRunLog({ command: args.command, mode: args.mode, repoRoot: args.repoRoot });\n",
    """  const log = startRunLog({
    command: args.command,
    type: args.type ?? `scan-${args.mode}`,
    mode: args.mode,
    repoRoot: args.repoRoot,
  });
""",
)

replace_once(
    "extension/src/ui/home.ts",
    "              command: 'vscode: drift.scanDependencies',\n              mode: resolvedChoices.deep ? 'deep' : 'quick',\n",
    "              command: 'vscode: drift.scanDependencies',\n              type: `${includeDev ? 'dev' : 'runtime'}-${deep ? 'deep' : 'quick'}`,\n              mode: deep ? 'deep' : 'quick',\n",
)
replace_once(
    "extension/src/ui/home.ts",
    "              command: 'vscode: drift.verify',\n              mode: 'deep',\n",
    "              command: 'vscode: drift.verify',\n              type: 'verify-deep',\n              mode: 'deep',\n",
)
replace_once(
    "extension/src/extension.ts",
    " * lifetime. Each operation overwrites the previous run's file, so the log\n * always reflects only the most recent thing Drift did in that repo.\n",
    " * lifetime. Each operation gets its own typed, timestamped artifact under\n * the resolved git directory, so repeated and overlapping runs remain available.\n",
)
