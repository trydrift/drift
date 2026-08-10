import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  declarationsIn,
  dartPublicApi,
  elixirModules,
  erlangExports,
  hexPublicApi,
} from '../dist/evidence/surface/index.js';

/**
 * Two ecosystems whose capability rows said "No API surface" and were wrong
 * about it.
 *
 * Neither Dart nor Hex publishes a compiled artefact describing its API, which
 * is what the old note reacted to. Both publish something better for this
 * purpose: the source, plus a visibility rule the whole ecosystem follows.
 * Dart's is `lib/` public and `lib/src/` private; Elixir's is `def` public and
 * `defp` private. The tests below are about the places where reading that
 * source naively produces a symbol that does not exist — and every one of them
 * is a real package that really produced it.
 */

const entry = (path: string, content: string) => ({
  path,
  size: content.length,
  read: () => Buffer.from(content, 'utf8'),
});

describe('Dart', () => {
  test('a private implementation library is reached only through its export', () => {
    const api = dartPublicApi([
      entry('lib/http.dart', `export 'src/client.dart';`),
      entry('lib/src/client.dart', `class Client {\n  void send() {}\n}`),
      entry('lib/src/hidden.dart', `class NeverExported {}`),
    ]);

    assert.ok(api.has('Client'));
    assert.ok(!api.has('NeverExported'), 'lib/src is private unless something exports it');
  });

  test('the example app is not the package', () => {
    const api = dartPublicApi([
      entry('lib/provider.dart', `class Provider {}`),
      entry('example/lib/main.dart', `class MyHomePage {}\nvoid main() {}`),
    ]);

    assert.deepEqual([...api.keys()], ['Provider']);
  });

  test('an unnamed extension contributes no symbol', () => {
    const declarations = declarationsIn(`extension on XMLHttpRequest {\n  int get code => 1;\n}`);
    assert.deepEqual(declarations.map((d) => d.name), []);
  });

  test('a local inside a method is not a member of the class', () => {
    const declarations = declarationsIn(
      `class BrowserClient {\n  void send() {\n    var splitIdx = 0;\n    final key = 'a';\n  }\n\n  int get status => 1;\n}`,
    );
    assert.deepEqual(declarations[0]!.members, ['send', 'status']);
  });

  test('a private declaration is private however it is spelled', () => {
    const declarations = declarationsIn(`class _Internal {}\nclass Public {}\nvoid _helper() {}`);
    assert.deepEqual(declarations.map((d) => d.name), ['Public']);
  });
});

describe('Hex', () => {
  test('defp is private and def is not', () => {
    const modules = elixirModules(
      `defmodule Jason do\n  def encode(v), do: v\n  defp escape(v), do: v\nend`,
    );
    assert.deepEqual([...modules.get('Jason')!], ['encode/1']);
  });

  test('a default argument defines every arity it generates', () => {
    const modules = elixirModules(
      `defmodule Plug.Conn do\n  def get_session(conn, key, default \\\\ nil) do\n    conn\n  end\nend`,
    );
    assert.deepEqual([...modules.get('Plug.Conn')!], ['get_session/2', 'get_session/3']);
  });

  test('a wrapped parameter list is still one parameter list', () => {
    const modules = elixirModules(
      `defmodule A do\n  def call(\n    conn,\n    opts\n  ) do\n    conn\n  end\nend`,
    );
    assert.deepEqual([...modules.get('A')!], ['call/2']);
  });

  test('a protocol implementation belongs to the protocol, not the enclosing module', () => {
    const modules = elixirModules(
      `defmodule Plug.Conn do\n  def get(x), do: x\n\n  defimpl Collectable do\n    def into(conn), do: conn\n  end\nend`,
    );
    assert.deepEqual([...modules.get('Plug.Conn')!], ['get/1']);
  });

  test('a defmodule inside @moduledoc is an example, not a module', () => {
    const modules = elixirModules(
      `defmodule Jason.Encoder do\n  @moduledoc """\n      defmodule Test do\n      end\n  """\n  def encode(v), do: v\nend`,
    );
    assert.deepEqual([...modules.keys()], ['Jason.Encoder']);
  });

  test('Erlang says what it exports outright', () => {
    assert.deepEqual(erlangExports(`-module(x).\n-export([start/0, stop/1]).\n-export([go/2]).`), [
      'start/0',
      'stop/1',
      'go/2',
    ]);
  });

  test('only lib and src are the package; priv and mix.exs are not', () => {
    const api = hexPublicApi([
      entry('lib/a.ex', `defmodule A do\n  def go(x), do: x\nend`),
      entry('mix.exs', `defmodule Mix.Tasks.Nope do\n  def run(_), do: :ok\nend`),
    ]);

    assert.deepEqual([...api.keys()], ['A']);
  });
});
