/**
 * Shell completion scripts, generated from the help text itself.
 *
 * The interesting decision here is where the vocabulary comes from. A
 * completion script is a second copy of "what commands and options exist", and
 * a second copy is a copy that goes stale: the option gets added, the script
 * does not learn about it, and the shell quietly insists a real flag is not a
 * flag. That is worse than no completion at all, because it is wrong with
 * confidence.
 *
 * So nothing is listed twice. `drift completion` builds this spec out of the
 * same per-command help topics that `knownFlags` reads to decide whether an
 * argument is a typo — one source, already covered by a test asserting every
 * flag the CLI reads appears in its help. An option that exists is an option
 * that completes, and an option that completes is one the CLI actually accepts.
 *
 * The scripts are printed rather than installed. Writing to a user's shell
 * configuration is not a thing a dependency scanner should do uninvited, and
 * `eval "$(drift completion zsh)"` is a line someone can read before running.
 */

/** Everything a shell needs to know to complete a `drift` command line. */
export interface CompletionSpec {
  /** Commands, in the order the overview lists them. */
  commands: readonly string[];
  /** Topics `drift help <topic>` accepts — commands plus things like `environment`. */
  topics: readonly string[];
  /** Long options each command accepts, without the leading dashes. */
  flagsByCommand: Readonly<Record<string, readonly string[]>>;
  /** Options whose next word is a value, so the shell offers a value and not another flag. */
  valueFlags: readonly string[];
  /** Options whose value is a directory. */
  directoryFlags: readonly string[];
  /** Options whose value is a file. */
  fileFlags: readonly string[];
}

export const COMPLETION_SHELLS = ['bash', 'zsh', 'fish'] as const;

export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

export function isCompletionShell(value: string): value is CompletionShell {
  return (COMPLETION_SHELLS as readonly string[]).includes(value);
}

/** The completion script for one shell. */
export function completionScript(shell: CompletionShell, spec: CompletionSpec): string {
  if (shell === 'bash') return bashScript(spec);
  if (shell === 'zsh') return zshScript(spec);
  return fishScript(spec);
}

/**
 * Shell-quote a word for inclusion in a generated script.
 *
 * Command and flag names are `[a-z-]` today, so this never has anything to do.
 * It is here because a generator that interpolates unquoted strings into shell
 * source is one careless name away from a script that executes them, and the
 * cost of it never being needed is nothing.
 */
function quote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

function flagsFor(spec: CompletionSpec, command: string): readonly string[] {
  return spec.flagsByCommand[command] ?? [];
}

/**
 * The `case` branches for options that take a value.
 *
 * Built rather than interpolated because an empty group is not an empty
 * branch: `case $x in )` is a syntax error, and a completion script that does
 * not parse breaks every new interactive shell. A spec with no file options
 * has to produce no file branch at all.
 */
function valueBranches(
  spec: CompletionSpec,
  actions: { directory: string; file: string; plain: string },
): string {
  const seen = new Set<string>();
  const branches: string[] = [];

  const add = (flags: readonly string[], action: string): void => {
    // First branch wins in a `case`, so a flag already matched above must not
    // be repeated below — `--dir` is a directory before it is merely a value.
    const fresh = flags.filter((flag) => !seen.has(flag));
    for (const flag of fresh) seen.add(flag);
    if (fresh.length === 0) return;
    branches.push(`    ${fresh.map((flag) => `--${flag}`).join('|')})\n      ${action} ;;`);
  };

  add(spec.directoryFlags, actions.directory);
  add(spec.fileFlags, actions.file);
  add(spec.valueFlags, actions.plain);

  // A `case` with no branches at all is also invalid; `*)` matching nothing is
  // the harmless way to keep the shape.
  return branches.length > 0 ? branches.join('\n') : '    *) ;;';
}

function bashScript(spec: CompletionSpec): string {
  const valueBranchSource = valueBranches(spec, {
    directory: 'COMPREPLY=($(compgen -d -- "$current")); return',
    file: 'COMPREPLY=($(compgen -f -- "$current")); return',
    plain: 'return',
  });
  const perCommand = spec.commands
    .map((command) => {
      const flags = flagsFor(spec, command)
        .map((flag) => `--${flag}`)
        .join(' ');
      return `    ${quote(command)}) options=${quote(flags)} ;;`;
    })
    .join('\n');

  return `# drift completion for bash
# Install with:  eval "$(drift completion bash)"  in ~/.bashrc
_drift_complete() {
  local current previous command options index
  COMPREPLY=()
  current="\${COMP_WORDS[COMP_CWORD]}"
  previous="\${COMP_WORDS[COMP_CWORD-1]}"

  # The first word that is not an option is the command being completed for.
  command=""
  for ((index = 1; index < COMP_CWORD; index++)); do
    case "\${COMP_WORDS[index]}" in
      -*) ;;
      *) command="\${COMP_WORDS[index]}"; break ;;
    esac
  done

  # A value goes after these, never another flag.
  case "$previous" in
${valueBranchSource}
  esac

  if [[ -z "$command" ]]; then
    COMPREPLY=($(compgen -W ${quote(spec.commands.join(' '))} -- "$current"))
    return
  fi

  if [[ "$command" == "help" && "$current" != -* ]]; then
    COMPREPLY=($(compgen -W ${quote(spec.topics.join(' '))} -- "$current"))
    return
  fi

  options=""
  case "$command" in
${perCommand}
  esac
  COMPREPLY=($(compgen -W "$options" -- "$current"))
}
complete -F _drift_complete drift
`;
}

function zshScript(spec: CompletionSpec): string {
  const valueBranchSource = valueBranches(spec, {
    directory: '_files -/; return',
    file: '_files; return',
    plain: 'return',
  });
  const perCommand = spec.commands
    .map((command) => {
      const flags = flagsFor(spec, command)
        .map((flag) => `--${flag}`)
        .join(' ');
      return `      ${quote(command)}) options=(\${=${'$'}{(z)${quote(flags)}}}) ;;`;
    })
    .join('\n');

  return `#compdef drift
# drift completion for zsh
# Install with:  eval "$(drift completion zsh)"  in ~/.zshrc
_drift_complete() {
  local -a options topics commands
  local command index
  commands=(\${=${'$'}{(z)${quote(spec.commands.join(' '))}}})
  topics=(\${=${'$'}{(z)${quote(spec.topics.join(' '))}}})

  command=""
  for ((index = 2; index < CURRENT; index++)); do
    case "\${words[index]}" in
      -*) ;;
      *) command="\${words[index]}"; break ;;
    esac
  done

  case "\${words[CURRENT-1]}" in
${valueBranchSource}
  esac

  if [[ -z "$command" ]]; then
    _describe 'command' commands
    return
  fi

  if [[ "$command" == "help" && "\${words[CURRENT]}" != -* ]]; then
    _describe 'topic' topics
    return
  fi

  options=()
  case "$command" in
${perCommand}
  esac
  _describe 'option' options
}
compdef _drift_complete drift
`;
}

function fishScript(spec: CompletionSpec): string {
  const lines: string[] = [
    '# drift completion for fish',
    '# Install with:  drift completion fish > ~/.config/fish/completions/drift.fish',
    '',
    '# The command is the first non-option word, so options only complete once one is typed.',
    'function __drift_command',
    '    set -l tokens (commandline -opc)',
    '    for token in $tokens[2..-1]',
    '        switch $token',
    '            case "-*"',
    '            case "*"',
    '                echo $token',
    '                return',
    '        end',
    '    end',
    'end',
    '',
    'function __drift_no_command',
    '    test -z (__drift_command)',
    'end',
    '',
    'function __drift_using',
    '    test (__drift_command) = $argv[1]',
    'end',
    '',
    '# Only the completions below; drift takes no bare filenames.',
    'complete -c drift -f',
    '',
  ];

  for (const command of spec.commands) {
    lines.push(`complete -c drift -n __drift_no_command -a ${quote(command)}`);
  }
  lines.push('');

  for (const topic of spec.topics) {
    lines.push(`complete -c drift -n ${quote('__drift_using help')} -a ${quote(topic)}`);
  }
  lines.push('');

  for (const command of spec.commands) {
    for (const flag of flagsFor(spec, command)) {
      const needsValue = spec.valueFlags.includes(flag);
      const directory = spec.directoryFlags.includes(flag);
      const file = spec.fileFlags.includes(flag);
      const suffix = directory ? ' -r -a "(__fish_complete_directories)"' : file ? ' -r -F' : needsValue ? ' -r' : '';
      lines.push(`complete -c drift -n ${quote(`__drift_using ${command}`)} -l ${flag}${suffix}`);
    }
  }

  return `${lines.join('\n')}\n`;
}
