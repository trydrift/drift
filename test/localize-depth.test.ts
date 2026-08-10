import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, rustBindings, resolveLocalSpecifier } from '../dist/index/metarag.js';
import { localize } from '../dist/localize/index.js';
import { moduleMapKey } from '../dist/localize/modules.js';
import { createLogger } from '../dist/util/logger.js';

/**
 * The ecosystems Drift could not previously localize, and the two mechanisms
 * that changed that: names read from the published artefact, and the
 * repository's own re-export graph.
 *
 * Every test here is written as a claim about a *finding* rather than about an
 * intermediate structure, because the intermediate structures are exactly what
 * a refactor is allowed to change. What may not change is which line of which
 * file a developer is sent to, and how sure Drift says it is.
 */

const logger = createLogger('error');

const dep = (name: string, ecosystem: string) => ({
  name,
  ecosystem: ecosystem as never,
  from: '1.0.0',
  to: '2.0.0',
  kind: 'runtime' as const,
  bump: 'major' as const,
  manifestPath: 'manifest',
});

const file = (path: string, language: string, content: string) => ({
  path,
  language: language as never,
  content,
  lineCount: content.split('\n').length,
});

const change = (dependency: string, symbols: string[], kind = 'removed-export') => ({
  id: 'bc-1',
  dependency,
  kind: kind as never,
  summary: `${symbols[0]} was removed`,
  symbols,
  confidence: 'high' as const,
  evidenceIds: [],
  remediation: 'Stop using it.',
});

const run = (
  files: ReturnType<typeof file>[],
  dependency: ReturnType<typeof dep>,
  breaking: ReturnType<typeof change>,
  options: Record<string, unknown> = {},
) => localize([breaking], [dependency], buildIndex(files), files, { logger, ...options });

/* ---------------- ecosystems that had no localizer at all ---------------- */

describe('PHP', () => {
  const composer = dep('symfony/http-foundation', 'packagist');

  test('finds a use of a class through the package autoload map', () => {
    const files = [
      file(
        'src/Controller/Home.php',
        'php',
        `<?php
namespace App\\Controller;

use Symfony\\Component\\HttpFoundation\\Request;

class Home {
    public function index(Request $request) {
        return Request::createFromGlobals();
    }
}`,
      ),
    ];

    const maps = new Map([
      [
        moduleMapKey('packagist', 'symfony/http-foundation'),
        { names: ['Symfony\\Component\\HttpFoundation'], source: 'composer.json autoload' },
      ],
    ]);

    const sites = run(files, composer, change('symfony/http-foundation', ['Request']), {
      moduleMaps: maps,
    });

    assert.ok(sites.length > 0, 'a PSR-4 root should reach the class that lives under it');
    assert.equal(sites[0]!.file, 'src/Controller/Home.php');
    assert.equal(sites[0]!.confidence, 'high', 'the file binds the name with a `use` statement');
  });

  test('a class from a different vendor is not this package', () => {
    const files = [
      file(
        'src/Other.php',
        'php',
        `<?php
use Laminas\\Http\\Request;

class Other { public function go(Request $r) { return $r; } }`,
      ),
    ];

    const maps = new Map([
      [
        moduleMapKey('packagist', 'symfony/http-foundation'),
        { names: ['Symfony\\Component\\HttpFoundation'], source: 'composer.json autoload' },
      ],
    ]);

    assert.deepEqual(
      run(files, composer, change('symfony/http-foundation', ['Request']), { moduleMaps: maps }),
      [],
      'a `Request` bound from Laminas is Laminas’s',
    );
  });
});

describe('Elixir', () => {
  test('a fully qualified call needs no alias to be found', () => {
    const files = [
      file(
        'lib/app/encoder.ex',
        'elixir',
        `defmodule App.Encoder do
  def encode(value) do
    Jason.encode!(value)
  end
end`,
      ),
    ];

    const maps = new Map([
      [moduleMapKey('hex', 'jason'), { names: ['Jason', 'Jason.Encoder'], source: 'hex tarball' }],
    ]);

    const sites = run(files, dep('jason', 'hex'), change('jason', ['encode!'], 'signature-change'), {
      moduleMaps: maps,
    });

    assert.equal(sites.length, 1);
    assert.equal(sites[0]!.line, 3);
  });

  test('an alias inside @moduledoc is documentation, not a dependency edge', () => {
    const source = [
      'defmodule App.Controller do',
      '  @moduledoc """',
      '  Fetch a record:',
      '',
      '      alias MyApp.Repo',
      '      Repo.get(User, id)',
      '  """',
      '  def show(conn), do: conn',
      'end',
    ].join('\n');

    const files = [file('lib/app/controller.ex', 'elixir', source)];
    const maps = new Map([
      [moduleMapKey('hex', 'some_repo'), { names: ['Repo'], source: 'hex tarball' }],
    ]);

    assert.deepEqual(
      run(files, dep('some_repo', 'hex'), change('some_repo', ['get'], 'signature-change'), {
        moduleMaps: maps,
      }),
      [],
      'a package called Repo is not a dependency of every file documenting one',
    );
  });

  test('a stdlib module is never attributed to a package', () => {
    const files = [
      file('lib/app/text.ex', 'elixir', `defmodule App.Text do\n  def up(s), do: String.upcase(s)\nend`),
    ];
    assert.deepEqual(run(files, dep('string_helpers', 'hex'), change('string_helpers', ['upcase'])), []);
  });
});

describe('Swift', () => {
  test('the module name comes from the manifest, not the repository name', () => {
    const files = [
      file(
        'Sources/App/Log.swift',
        'swift',
        `import Logging\n\nfunc make() -> Logger {\n    return Logger(label: "app")\n}`,
      ),
    ];

    const maps = new Map([
      [moduleMapKey('swift', 'apple/swift-log'), { names: ['Logging'], source: 'Package.swift' }],
    ]);

    const sites = run(files, dep('apple/swift-log', 'swift'), change('apple/swift-log', ['Logger']), {
      moduleMaps: maps,
    });

    assert.ok(sites.length > 0);
    assert.ok(sites.every((s) => s.file === 'Sources/App/Log.swift'));
    assert.ok(
      sites.every((s) => s.confidence === 'medium'),
      'a Swift import binds no name, so the ceiling is medium',
    );
  });
});

describe('Ruby', () => {
  test('a constant Bundler required for you is still a reference', () => {
    const files = [
      file(
        'app/models/user.rb',
        'ruby',
        `class User\n  def name\n    ActiveSupport::Inflector.titleize(@name)\n  end\nend`,
      ),
    ];

    const maps = new Map([
      [
        moduleMapKey('rubygems', 'activesupport'),
        { names: ['active_support', 'ActiveSupport'], source: 'activesupport.gem' },
      ],
    ]);

    const sites = run(
      files,
      dep('activesupport', 'rubygems'),
      change('activesupport', ['titleize'], 'signature-change'),
      { moduleMaps: maps },
    );

    assert.equal(sites.length, 1, 'no `require` line, and the reference is still found');
    assert.equal(sites[0]!.line, 3);
  });
});

/* ---------------- names from the artefact, not from a table ---------------- */

describe('artefact-derived names', () => {
  test('a Maven finding does not land in a file importing a sibling artifact', () => {
    const files = [
      file(
        'src/main/java/app/Read.java',
        'java',
        `package app;\n\nimport com.fasterxml.jackson.databind.ObjectMapper;\n\npublic class Read {\n  ObjectMapper m = new ObjectMapper();\n}`,
      ),
    ];

    // The jar for jackson-core ships `com.fasterxml.jackson.core`, and nothing
    // under `...databind`. The group-prefix proxy could not tell them apart.
    const maps = new Map([
      [
        moduleMapKey('maven', 'com.fasterxml.jackson.core:jackson-core'),
        { names: ['com.fasterxml.jackson.core'], source: 'jackson-core.jar' },
      ],
    ]);

    assert.deepEqual(
      run(
        files,
        dep('com.fasterxml.jackson.core:jackson-core', 'maven'),
        change('com.fasterxml.jackson.core:jackson-core', ['ObjectMapper']),
        { moduleMaps: maps },
      ),
      [],
    );
  });

  test('a Python distribution whose import name is nothing like it', () => {
    const files = [
      file('app/img.py', 'python', `from wand.image import Image\n\ndef open(path):\n    return Image(filename=path)`),
    ];

    const maps = new Map([
      [moduleMapKey('pypi', 'Wand'), { names: ['wand'], source: 'Wand-0.6.13 top_level.txt' }],
    ]);

    const sites = run(files, dep('Wand', 'pypi'), change('Wand', ['Image']), { moduleMaps: maps });
    assert.ok(sites.length > 0, 'no alias table entry existed, and the wheel knew');
    assert.ok(
      sites.some((s) => s.line === 4),
      'the call is reported, not only the import that names it',
    );
  });
});

/* ---------------- the repository's own graph ---------------- */

describe('re-export graph', () => {
  const files = [
    file('src/http/index.ts', 'typescript', `export { request, type Options } from 'undici';`),
    file(
      'src/feature/load.ts',
      'typescript',
      `import { request } from '../http/index';\n\nexport async function load(url: string) {\n  return request(url);\n}`,
    ),
    file(
      'src/feature/wrapped.ts',
      'typescript',
      `import { helper } from './helper';\n\nexport const go = () => helper();`,
    ),
    file('src/feature/helper.ts', 'typescript', `export const helper = () => 1;`),
  ];

  test('a call behind a barrel file is found', () => {
    const sites = run(files, dep('undici', 'npm'), change('undici', ['request']));
    const paths = sites.map((s) => s.file);
    assert.ok(paths.includes('src/http/index.ts'), 'the barrel itself');
    assert.ok(paths.includes('src/feature/load.ts'), 'and the file one edge past it');
  });

  test('the inherited site is never reported as certain as the direct one', () => {
    const sites = run(files, dep('undici', 'npm'), change('undici', ['request']));
    const indirect = sites.find((s) => s.file === 'src/feature/load.ts');
    assert.equal(indirect?.confidence, 'medium', 'it asked for `request` by name');
    const direct = sites.find((s) => s.file === 'src/http/index.ts');
    assert.equal(direct?.confidence, 'high');
  });

  test('a file with no path to the dependency is untouched', () => {
    const sites = run(files, dep('undici', 'npm'), change('undici', ['request']));
    assert.ok(!sites.some((s) => s.file === 'src/feature/wrapped.ts'));
  });

  test('a wrapper does not forward, so its callers are not sites', () => {
    const wrapped = [
      file(
        'src/http/client.ts',
        'typescript',
        `import { request } from 'undici';\n\nexport function get(url: string) {\n  return request(url);\n}`,
      ),
      file(
        'src/feature/use.ts',
        'typescript',
        `import { get } from '../http/client';\n\nexport const run = () => get('/');`,
      ),
    ];

    const sites = run(wrapped, dep('undici', 'npm'), change('undici', ['request']));
    assert.deepEqual(
      [...new Set(sites.map((s) => s.file))],
      ['src/http/client.ts'],
      'the wrapper breaks; its callers have nothing to change',
    );
  });

  test('a C header pulled in through another header still reaches the caller', () => {
    const cFiles = [
      file('src/compat.h', 'c', `#pragma once\n#include <zlib.h>\n`),
      file(
        'src/deflate.c',
        'c',
        `#include "compat.h"\n\nint go(void) {\n  return deflateInit2(0, 0, 0, 0, 0, 0);\n}`,
      ),
    ];

    const sites = run(cFiles, dep('zlib', 'conan'), change('zlib', ['deflateInit2'], 'signature-change'));
    assert.ok(
      sites.some((s) => s.file === 'src/deflate.c'),
      'a transitive include is the ordinary case in C, not the exception',
    );
  });

  test('following the graph can be switched off', () => {
    const sites = run(files, dep('undici', 'npm'), change('undici', ['request']), {
      maxReExportDepth: 0,
    });
    assert.deepEqual([...new Set(sites.map((s) => s.file))], ['src/http/index.ts']);
  });
});

/* ---------------- shadowing by the repository's own declarations ---------------- */

describe('local declarations shadow the dependency', () => {
  test('a function the repository defines itself is not the package’s', () => {
    const files = [
      file(
        'src/util.ts',
        'typescript',
        `import { createServer } from 'node-thing';\n\nexport function parse(input: string) {\n  return input.trim();\n}\n\nexport const x = parse('a');`,
      ),
    ];

    const sites = run(files, dep('node-thing', 'npm'), change('node-thing', ['parse']));
    assert.deepEqual(sites, [], 'the file declares its own `parse`');
  });

  test('an explicitly imported name is still the package’s', () => {
    const files = [
      file(
        'src/util.ts',
        'typescript',
        `import { parse } from 'node-thing';\n\nexport const value = parse('a');`,
      ),
    ];

    const sites = run(files, dep('node-thing', 'npm'), change('node-thing', ['parse']));
    assert.ok(sites.length > 0);
    assert.ok(sites.every((s) => s.confidence === 'high'));
  });
});

/* ---------------- the smaller corrections ---------------- */

describe('Rust use statements bind leaves, not path segments', () => {
  test('intermediate modules are not bindings', () => {
    assert.deepEqual(rustBindings('serde::de::Deserializer'), ['Deserializer']);
  });

  test('grouped and aliased forms', () => {
    assert.deepEqual(rustBindings('tokio::{net::TcpListener, sync::Mutex as Lock}'), [
      'TcpListener',
      'Lock',
    ]);
  });

  test('a glob is a glob', () => {
    assert.deepEqual(rustBindings('rayon::prelude::*'), ['*']);
  });
});

describe('local specifier resolution', () => {
  const known = new Set(['src/a/util.ts', 'src/a/index.ts', 'src/b/util.ts', 'include/log.h']);
  const byStem = new Map<string, string[]>([
    ['util.ts', ['src/a/util.ts', 'src/b/util.ts']],
    ['index.ts', ['src/a/index.ts']],
    ['log.h', ['include/log.h']],
  ]);

  test('a relative specifier resolves against its own directory', () => {
    assert.equal(resolveLocalSpecifier('src/a/main.ts', './util', known, byStem), 'src/a/util.ts');
  });

  test('an include resolves by its full suffix', () => {
    assert.equal(resolveLocalSpecifier('src/a/main.c', 'log.h', known, byStem), 'include/log.h');
  });

  test('an ambiguous basename resolves to nothing at all', () => {
    const ambiguous = new Map<string, string[]>([['util.h', ['a/util.h', 'b/util.h']]]);
    assert.equal(
      resolveLocalSpecifier('src/main.c', 'util.h', new Set(['a/util.h', 'b/util.h']), ambiguous),
      undefined,
    );
  });

  test('a path escaping the repository root resolves to nothing', () => {
    assert.equal(resolveLocalSpecifier('main.ts', '../../outside', known, byStem), undefined);
  });
});

describe('reading modules out of a Hex tarball', () => {
  test('an example inside @moduledoc is documentation, not a module', async () => {
    const { elixirModulesIn } = await import('../dist/localize/modules.js');
    const source = `defmodule Jason.Encoder do
  @moduledoc """
  Protocol controlling how a value is encoded.

      defmodule Test do
        @derive Jason.Encoder
        defstruct [:a]
      end
  """
  def encode(value), do: value
end`;
    assert.deepEqual(elixirModulesIn(source), ['Jason.Encoder']);
  });

  test('a nested module is named for where it lives', async () => {
    const { elixirModulesIn } = await import('../dist/localize/modules.js');
    const source = `defmodule Jason.Decoder do\n  defmodule Unescape do\n    def parse(x), do: x\n  end\nend`;
    assert.deepEqual(elixirModulesIn(source), ['Jason.Decoder', 'Jason.Decoder.Unescape']);
  });
});
