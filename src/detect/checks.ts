import { tryJson } from './ecosystems/types.js';
import { scanTomlTables } from './ecosystems/toml.js';
import type { Command, PackageManagerId } from './package-manager.js';

/**
 * The local checks a project already has.
 *
 * After an agent edits code, the honest question is not "does Drift think this
 * is right" but "does your own toolchain still pass". That answer exists in
 * every repository already, and running it costs nothing and reaches no
 * network — it is the strongest signal Drift can offer a reviewer without
 * asking them to read every line.
 *
 * Only checks that actually exist are offered. Proposing `npm run typecheck` to
 * a project with no such script produces a failure that means nothing, and a
 * meaningless failure is worse than no check at all.
 */

export type CheckKind = 'typecheck' | 'test' | 'build';

export interface LocalCheck {
  kind: CheckKind;
  /** What the developer sees, e.g. `npm run typecheck`. */
  label: string;
  command: Command;
  /** Where Drift found it, so the offer can be justified. */
  source: string;
  /**
   * Whether a pass of this specific check proves the compiler saw the real
   * declarations — able to disprove a signature change, a removed export, a
   * narrowed type.
   *
   * `kind` alone used to stand in for this, but `kind` is a naming bucket
   * (`typecheck`, `build`), and for Node a name is only ever a guess at what
   * the script actually runs: `"check": "eslint ."` lands in the `typecheck`
   * bucket by name and checks nothing a compiler would. Every check Drift
   * builds itself (`cargo check`, `go build`, `mvn test-compile`, …) is a
   * known, literal command, so its capability is a fact Drift already has;
   * only the Node path, where the command comes from a project's own script
   * body, has to actually look at what that body invokes.
   */
  compileCapable: boolean;
}

/**
 * Ordered typecheck → test → build.
 *
 * A type error explains a test failure, and a test failure explains a broken
 * build. Running them the other way round makes the reviewer read the least
 * informative output first.
 */
const ORDER: CheckKind[] = ['typecheck', 'test', 'build'];

/** Script names that mean each kind, most conventional first. */
const SCRIPT_NAMES: Record<CheckKind, string[]> = {
  typecheck: ['typecheck', 'type-check', 'types', 'check-types', 'tsc', 'check'],
  test: ['test', 'tests', 'test:unit'],
  build: ['build', 'compile'],
};

/**
 * Which local checks this manifest offers.
 *
 * `manifest` is the content of the file the package manager owns; `null` means
 * it could not be read, which yields the checks that need no manifest (a Cargo
 * or Go project's checks are the toolchain's, not the project's).
 */
export function detectChecks(
  manager: PackageManagerId,
  manifest: string | null,
): LocalCheck[] {
  const found = checksFor(manager, manifest);
  return ORDER.flatMap((kind) => found.filter((check) => check.kind === kind));
}

function checksFor(manager: PackageManagerId, manifest: string | null): LocalCheck[] {
  switch (manager) {
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'yarn-berry':
    case 'bun':
      return nodeScripts(manager, manifest);
    case 'cargo':
      return [
        check('typecheck', { command: 'cargo', args: ['check'] }, 'the Cargo toolchain'),
        check('test', { command: 'cargo', args: ['test'] }, 'the Cargo toolchain'),
        check('build', { command: 'cargo', args: ['build'] }, 'the Cargo toolchain', true),
      ];
    case 'go':
      return [
        check('typecheck', { command: 'go', args: ['vet', './...'] }, 'the Go toolchain'),
        check('test', { command: 'go', args: ['test', './...'] }, 'the Go toolchain'),
        check('build', { command: 'go', args: ['build', './...'] }, 'the Go toolchain', true),
      ];
    case 'poetry':
    case 'uv':
    case 'pip':
      return pythonChecks(manager, manifest);
    case 'bundler':
      return rubyChecks(manifest);
    case 'maven':
      return [
        check('typecheck', { command: 'mvn', args: ['-q', 'test-compile'] }, 'Maven'),
        check('test', { command: 'mvn', args: ['-q', 'test'] }, 'Maven'),
        check('build', { command: 'mvn', args: ['-q', 'package', '-DskipTests'] }, 'Maven', true),
      ];
    case 'gradle':
      return [
        check('typecheck', { command: 'gradle', args: ['compileTestJava'] }, 'Gradle'),
        check('test', { command: 'gradle', args: ['test'] }, 'Gradle'),
        check('build', { command: 'gradle', args: ['build', '-x', 'test'] }, 'Gradle', true),
      ];
    case 'sbt':
      return [
        // `sbt Test/compile` typechecks production and test sources together,
        // which is the closest thing sbt has to a typecheck-only pass.
        check('typecheck', { command: 'sbt', args: ['Test/compile'] }, 'sbt'),
        check('test', { command: 'sbt', args: ['test'] }, 'sbt'),
        check('build', { command: 'sbt', args: ['package'] }, 'sbt', true),
      ];
    case 'dotnet':
      return [
        check('typecheck', { command: 'dotnet', args: ['build', '--nologo'] }, 'the .NET SDK'),
        check('test', { command: 'dotnet', args: ['test', '--nologo'] }, 'the .NET SDK'),
        check('build', { command: 'dotnet', args: ['publish', '--nologo'] }, 'the .NET SDK', true),
      ];
    case 'composer':
      return composerChecks(manifest);
    case 'mix':
      return [
        // Elixir has no separate typechecker in the base toolchain, but
        // `--warnings-as-errors` turns the compiler's undefined-function and
        // arity warnings into failures — which is exactly the class of breakage
        // a dependency upgrade causes.
        check('typecheck', { command: 'mix', args: ['compile', '--warnings-as-errors'] }, 'Mix'),
        check('test', { command: 'mix', args: ['test'] }, 'Mix'),
        check('build', { command: 'mix', args: ['compile'] }, 'Mix', true),
      ];
    case 'rebar':
      return [
        check('typecheck', { command: 'rebar3', args: ['compile'] }, 'Rebar3'),
        check('test', { command: 'rebar3', args: ['eunit'] }, 'Rebar3'),
      ];
    case 'dart':
      return [
        check('typecheck', { command: 'dart', args: ['analyze'] }, 'the Dart SDK'),
        check('test', { command: 'dart', args: ['test'] }, 'the Dart SDK'),
      ];
    case 'flutter':
      return [
        check('typecheck', { command: 'flutter', args: ['analyze'] }, 'the Flutter SDK'),
        check('test', { command: 'flutter', args: ['test'] }, 'the Flutter SDK'),
      ];
    case 'swiftpm':
      return [
        check('typecheck', { command: 'swift', args: ['build'] }, 'the Swift toolchain'),
        check('test', { command: 'swift', args: ['test'] }, 'the Swift toolchain'),
      ];
    case 'cocoapods':
      // Deliberately empty. Building an iOS target needs Xcode, a scheme, and a
      // destination Drift cannot infer from a Podfile — and a check that fails
      // for setup reasons rather than code reasons teaches people to ignore
      // every check. The capability matrix says so out loud.
      return [];
    case 'opam':
      return [
        check('typecheck', { command: 'dune', args: ['build', '@check'] }, 'dune'),
        check('test', { command: 'dune', args: ['runtest'] }, 'dune'),
        check('build', { command: 'dune', args: ['build'] }, 'dune', true),
      ];
    case 'conan':
    case 'vcpkg':
      // C and C++ have no typecheck separate from the build — the compiler is
      // both — so the build is offered once and honestly rather than twice
      // under two names. It is also the strongest check either ecosystem has:
      // an incompatible header change is a compile error, not a runtime
      // surprise, which is the whole reason a C upgrade is easier to trust
      // than a Python one. The build itself belongs to CMake or Meson, which
      // Drift does not choose for a project; `--build=missing` and
      // `vcpkg install` get the dependencies in place for whatever it is.
      return [
        check(
          'build',
          manager === 'conan'
            ? { command: 'conan', args: ['build', '.'] }
            : { command: 'cmake', args: ['--build', 'build'] },
          manager === 'conan' ? 'Conan' : 'CMake',
          true,
        ),
      ];
    case 'arduino-cli':
      return [
        check(
          'build',
          { command: 'arduino-cli', args: ['compile', '--warnings', 'all'] },
          'Arduino CLI',
          true,
        ),
      ];
    case 'platformio':
      return [
        check('build', { command: 'pio', args: ['run'] }, 'PlatformIO', true),
        check('test', { command: 'pio', args: ['test'] }, 'PlatformIO'),
      ];
  }
}

/**
 * PHP declares its test runner in `composer.json`'s `require-dev`, and its
 * scripts block often wraps it. Prefer the declared script, because a project
 * that wrote one usually needed to.
 */
function composerChecks(manifest: string | null): LocalCheck[] {
  const doc = tryJson<{
    scripts?: Record<string, unknown>;
    'require-dev'?: Record<string, string>;
  }>(manifest ?? '');
  const out: LocalCheck[] = [];

  if (doc?.scripts && 'test' in doc.scripts) {
    out.push(check('test', { command: 'composer', args: ['run', 'test'] }, '`scripts.test` in composer.json'));
    return out;
  }

  const dev = doc?.['require-dev'] ?? {};
  if ('phpunit/phpunit' in dev) {
    out.push(
      check('test', { command: 'vendor/bin/phpunit', args: [] }, 'phpunit, declared in composer.json'),
    );
  } else if ('pestphp/pest' in dev) {
    out.push(check('test', { command: 'vendor/bin/pest', args: [] }, 'pest, declared in composer.json'));
  }

  if ('phpstan/phpstan' in dev) {
    out.push(
      check(
        'typecheck',
        { command: 'vendor/bin/phpstan', args: ['analyse'] },
        'phpstan, declared in composer.json',
      ),
    );
  } else if ('vimeo/psalm' in dev) {
    out.push(
      check('typecheck', { command: 'vendor/bin/psalm', args: [] }, 'psalm, declared in composer.json'),
    );
  }

  return out;
}

/**
 * Node projects declare their own checks, so Drift reads them rather than
 * assuming. The runner differs per manager but the script names do not.
 */
function nodeScripts(manager: PackageManagerId, manifest: string | null): LocalCheck[] {
  const scripts = tryJson<{ scripts?: Record<string, string> }>(manifest ?? '')?.scripts;
  if (!scripts) return [];

  const runner = manager === 'yarn' || manager === 'yarn-berry' ? 'yarn' : manager;
  const out: LocalCheck[] = [];

  for (const kind of ORDER) {
    const name = SCRIPT_NAMES[kind].find((candidate) => typeof scripts[candidate] === 'string');
    if (!name) continue;

    // `npm test` is the shorthand every Node developer knows; `yarn` needs no
    // `run` at all. Matching what a human would type keeps the offer legible.
    const args =
      name === 'test' && manager !== 'yarn' && manager !== 'yarn-berry'
        ? ['test']
        : runner === 'yarn'
          ? [name]
          : ['run', name];

    out.push(
      check(
        kind,
        { command: runner, args },
        `\`scripts.${name}\` in package.json`,
        kind !== 'test' && nodeCompileCapable(scripts[name]!),
      ),
    );
  }

  return out;
}

/**
 * The known TypeScript-family compiler frontends a Node script might invoke.
 * Deliberately short: a name missing from this list is a false negative (the
 * check still runs and can still fail the upgrade), while a name wrongly
 * added would be a false positive that erases a real finding — the failure
 * mode this whole feature exists to prevent.
 */
const NODE_COMPILERS = new Set(['tsc', 'vue-tsc', 'svelte-check']);

/**
 * Whether a Node script's own command line — not its name in `package.json`
 * — actually invokes a compiler that would surface a signature change, a
 * removed export, or a narrowed type.
 *
 * A `typecheck`-named script that runs `eslint .`, or a `build`-named script
 * that runs `vite build` (esbuild strips types without checking them), tells
 * a reviewer nothing a compiler would. Only the literal command matters, so
 * this reads the script body itself rather than trusting the name it was
 * filed under.
 */
function nodeCompileCapable(scriptBody: string): boolean {
  return scriptBody.split(/&&|\|\||;/).some((segment) => {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (tokens[i] && /^[\w.]+=/.test(tokens[i]!)) i += 1; // skip `FOO=bar tsc`
    if (tokens[i] === 'npx') i += 1;
    return tokens[i] !== undefined && NODE_COMPILERS.has(tokens[i]!);
  });
}

function pythonChecks(manager: PackageManagerId, manifest: string | null): LocalCheck[] {
  const content = manifest ?? '';
  const tables = scanTomlTables(content);
  const has = (header: string) => tables.some((t) => t.header === header || t.header.startsWith(`${header}.`));
  // The dependency lists are where a tool is declared even when it has no
  // config table of its own.
  const mentions = (tool: string) => new RegExp(`["']${tool}\\b`, 'i').test(content);

  const prefix = manager === 'poetry' ? ['poetry', 'run'] : manager === 'uv' ? ['uv', 'run'] : null;
  const wrap = (command: string, args: string[]): Command =>
    prefix ? { command: prefix[0]!, args: [...prefix.slice(1), command, ...args] } : { command, args };

  const out: LocalCheck[] = [];

  if (has('tool.mypy') || mentions('mypy')) {
    out.push(check('typecheck', wrap('mypy', ['.']), 'mypy, declared in pyproject.toml'));
  } else if (has('tool.pyright') || mentions('pyright')) {
    out.push(check('typecheck', wrap('pyright', []), 'pyright, declared in pyproject.toml'));
  }

  if (has('tool.pytest') || has('tool.pytest.ini_options') || mentions('pytest')) {
    out.push(check('test', wrap('pytest', []), 'pytest, declared in pyproject.toml'));
  }

  return out;
}

function rubyChecks(manifest: string | null): LocalCheck[] {
  const content = manifest ?? '';
  const out: LocalCheck[] = [];

  if (/gem\s+["']rspec/.test(content)) {
    out.push(check('test', { command: 'bundle', args: ['exec', 'rspec'] }, 'rspec, declared in the Gemfile'));
  } else if (/gem\s+["'](minitest|rake)/.test(content)) {
    out.push(check('test', { command: 'bundle', args: ['exec', 'rake', 'test'] }, 'rake, declared in the Gemfile'));
  }

  return out;
}

function check(
  kind: CheckKind,
  command: Command,
  source: string,
  /** Defaults to the `typecheck` bucket: every other hardcoded (non-Node) check is a literal, known toolchain command, so the default is correct except where overridden above for a `build` step that is itself the compiler. */
  compileCapable: boolean = kind === 'typecheck',
): LocalCheck {
  return { kind, label: [command.command, ...command.args].join(' '), command, source, compileCapable };
}
