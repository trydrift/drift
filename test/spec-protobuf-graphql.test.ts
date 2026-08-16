import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { gatherEvidence } from '../dist/evidence/index.js';
import {
  codeForBufRule,
  codeForChangeType,
  graphqlSpecProvider,
  parseBufBreaking,
  protobufSpecProvider,
  symbolFromBufMessage,
} from '../dist/evidence/spec/index.js';
import { DriftConfigSchema } from '../dist/config/schema.js';
import { createLogger } from '../dist/util/logger.js';
import type { CommandResult } from '../dist/util/exec.js';

/**
 * The two contract formats added on top of the `SpecProvider` interface.
 *
 * Mirrors the OpenAPI suite: does a real breaking change produce evidence with
 * the right source, weight and structured findings, does an additive change
 * produce none, and — for protobuf, which shells out — is a missing toolchain
 * an ordinary stated outcome rather than a silent clean result.
 *
 * `buf` is not installed in CI, so its process is stubbed the way the surface
 * providers' toolchains are: a fake `exec` returning recorded output. That is
 * the point of shelling out through an injected `Exec` — the parsing and the
 * mapping are testable without the binary, and the binary's absence is itself
 * one of the cases under test.
 */

const logger = createLogger('error');

function repoWith(path: string, before: string, after: string) {
  return async (requested: string, ref: string): Promise<string | null> => {
    if (requested !== path) return null;
    return ref === 'before' ? before : after;
  };
}

const ok = (stdout: string, code = 0): CommandResult => ({ code, stdout, stderr: '' });

/* ---------------------------------------------------------------- protobuf */

const PROTO_BEFORE = `syntax = "proto3";
package acme.users.v1;

message User {
  string id = 1;
  string email = 2;
}

service Users {
  rpc GetUser(User) returns (User);
  rpc DeleteUser(User) returns (User);
}
`;

const PROTO_AFTER = `syntax = "proto3";
package acme.users.v1;

message User {
  string id = 1;
}

service Users {
  rpc GetUser(User) returns (User);
}
`;

/** What `buf breaking --error-format=json` prints for exactly that change. */
const BUF_OUTPUT = [
  JSON.stringify({
    path: 'proto/users.proto',
    start_line: 5,
    start_column: 3,
    end_line: 5,
    end_column: 21,
    type: 'FIELD_NO_DELETE',
    message: 'Previously present field "2" with name "email" on message "User" was deleted.',
  }),
  JSON.stringify({
    path: 'proto/users.proto',
    start_line: 10,
    start_column: 3,
    end_line: 10,
    end_column: 40,
    type: 'RPC_NO_DELETE',
    message: 'Previously present RPC "DeleteUser" on service "Users" was deleted.',
  }),
].join('\n');

describe('protobuf, via buf breaking', () => {
  const path = 'proto/users.proto';

  function bufExec(breaking: CommandResult, version: CommandResult = ok('1.47.2')) {
    const calls: string[][] = [];
    const exec = async (command: string, args: readonly string[]): Promise<CommandResult> => {
      calls.push([command, ...args]);
      return args[0] === '--version' ? version : breaking;
    };
    return { exec, calls };
  }

  async function gather(exec: unknown, evidence: Record<string, unknown> = {}) {
    return gatherEvidence([], {
      config: DriftConfigSchema.parse({
        evidence: { protobuf: true, protobufSpecs: [path], ...evidence },
      }),
      logger,
      exec: exec as never,
      readRepoFile: repoWith(path, PROTO_BEFORE, PROTO_AFTER),
      beforeSha: 'before',
      afterSha: 'after',
    });
  }

  test('a deleted field and a deleted RPC become protobuf-diff evidence', async () => {
    // Exit code 100 is how buf reports findings, as distinct from failing.
    const { exec, calls } = bufExec(ok(BUF_OUTPUT, 100));
    const records = await gather(exec);

    assert.equal(records.length, 1);
    const record = records[0]!;
    assert.equal(record.source, 'protobuf-diff');
    assert.equal(record.dependency, path);
    assert.equal(record.weight, 1);
    assert.deepEqual(
      record.findings?.map((f) => [f.code, f.symbol]),
      [
        ['proto-field-removed', 'User.email'],
        ['proto-rpc-removed', 'Users.DeleteUser'],
      ],
    );
    // buf's own sentence is what a reviewer audits, so it must survive verbatim.
    assert.match(record.content, /Previously present field "2" with name "email"/);

    const breaking = calls.find((call) => call[1] === 'breaking');
    assert.ok(breaking, 'buf breaking must actually be invoked');
    assert.ok(breaking.includes('--against'), 'the old revision must be passed as --against');
    assert.ok(breaking.includes('--error-format=json'), 'output must be requested as JSON');
  });

  test('a clean comparison produces no evidence but is still reported as checked', async () => {
    const { exec } = bufExec(ok(''));
    const compared: string[] = [];

    const records = await gatherEvidence([], {
      config: DriftConfigSchema.parse({ evidence: { protobuf: true, protobufSpecs: [path] } }),
      logger,
      exec: exec as never,
      readRepoFile: repoWith(path, PROTO_BEFORE, PROTO_AFTER),
      beforeSha: 'before',
      afterSha: 'after',
      onSpecComputed: (comparedPath) => compared.push(comparedPath),
    });

    assert.deepEqual(records, []);
    assert.deepEqual(compared, [path]);
  });

  test('a missing buf is a stated gap with a remedy, never a clean result', async () => {
    const missing: CommandResult = { code: 1, stdout: '', stderr: '', failure: 'not-found' };
    const gaps: { reason: string; detail: string; remedy?: string }[] = [];

    const records = await gatherEvidence([], {
      config: DriftConfigSchema.parse({ evidence: { protobuf: true, protobufSpecs: [path] } }),
      logger,
      exec: (async () => missing) as never,
      readRepoFile: repoWith(path, PROTO_BEFORE, PROTO_AFTER),
      beforeSha: 'before',
      afterSha: 'after',
      onUnavailableSpec: (_path, reason) => gaps.push(reason),
    });

    assert.deepEqual(records, []);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]?.reason, 'tool-missing');
    assert.match(gaps[0]?.remedy ?? '', /buf\.build/);
  });

  test('a compile failure is reported as a toolchain failure, never as a finding', async () => {
    // buf reports a file that will not compile through the *same* channel as a
    // real incompatibility: `type: "COMPILE"`, exit code 100. Published as-is,
    // "imported file does not exist" would become a breaking change to the
    // contract — false, and the most damaging shape of wrong Drift can produce.
    const failure: CommandResult = {
      code: 100,
      stdout: JSON.stringify({
        path: 'after/proto/users.proto',
        start_line: 2,
        type: 'COMPILE',
        message: 'imported file does not exist',
      }),
      stderr: '',
    };
    const gaps: { reason: string; detail: string }[] = [];

    await gatherEvidence([], {
      config: DriftConfigSchema.parse({ evidence: { protobuf: true, protobufSpecs: [path] } }),
      logger,
      exec: (async (_c: string, args: readonly string[]) =>
        args[0] === '--version' ? ok('1.47.2') : failure) as never,
      readRepoFile: repoWith(path, PROTO_BEFORE, PROTO_AFTER),
      beforeSha: 'before',
      afterSha: 'after',
      onUnavailableSpec: (_path, reason) => gaps.push(reason),
    });

    assert.equal(gaps[0]?.reason, 'toolchain-failed');
    assert.match(gaps[0]?.detail ?? '', /does not exist/);
  });

  test('a buf invocation that fails outright is a gap too', async () => {
    const failure: CommandResult = { code: 1, stdout: '', stderr: 'unknown flag: --against' };
    const gaps: { reason: string }[] = [];

    await gatherEvidence([], {
      config: DriftConfigSchema.parse({ evidence: { protobuf: true, protobufSpecs: [path] } }),
      logger,
      exec: (async (_c: string, args: readonly string[]) =>
        args[0] === '--version' ? ok('1.47.2') : failure) as never,
      readRepoFile: repoWith(path, PROTO_BEFORE, PROTO_AFTER),
      beforeSha: 'before',
      afterSha: 'after',
      onUnavailableSpec: (_path, reason) => gaps.push(reason),
    });

    assert.equal(gaps[0]?.reason, 'toolchain-failed');
  });

  test('the provider is skipped when its flag is off', async () => {
    const { exec, calls } = bufExec(ok(BUF_OUTPUT, 100));
    assert.deepEqual(await gather(exec, { protobuf: false }), []);
    assert.deepEqual(calls, [], 'a disabled provider must not shell out at all');
  });

  test('only .proto documents are handled', () => {
    assert.equal(protobufSpecProvider.handles('proto/users.proto', PROTO_BEFORE), true);
    assert.equal(protobufSpecProvider.handles('api/openapi.yaml', PROTO_BEFORE), false);
    assert.equal(protobufSpecProvider.handles('proto/notes.proto', '# just a comment\n'), false);
  });

  test('non-JSON lines in buf output are skipped, not fatal', () => {
    const issues = parseBufBreaking(`Failure: some prose buf printed\n${BUF_OUTPUT}\n{"broken":`);
    assert.equal(issues.length, 2, 'the real findings must survive an unparseable neighbour');
  });

  test('buf rules map onto finding codes by category', () => {
    assert.equal(codeForBufRule('FIELD_NO_DELETE_UNLESS_NUMBER_RESERVED'), 'proto-field-removed');
    assert.equal(codeForBufRule('ENUM_VALUE_NO_DELETE'), 'proto-enum-value-removed');
    assert.equal(codeForBufRule('MESSAGE_NO_DELETE'), 'proto-message-removed');
    assert.equal(codeForBufRule('SERVICE_NO_DELETE'), 'proto-service-removed');
    assert.equal(codeForBufRule('RPC_SAME_REQUEST_TYPE'), 'proto-rpc-signature-changed');
    assert.equal(codeForBufRule('FIELD_SAME_TYPE'), 'proto-field-type-changed');
    assert.equal(codeForBufRule('FIELD_SAME_NAME'), 'proto-field-renamed');
    assert.equal(codeForBufRule('FILE_SAME_GO_PACKAGE'), 'proto-package-changed');
    // A rule buf adds after this was written still lands somewhere honest.
    assert.equal(codeForBufRule('SOMETHING_BUF_ADDED_LATER'), 'proto-contract-changed');
  });

  test('a symbol is read out of buf’s prose, and a field number never becomes one', () => {
    assert.equal(
      symbolFromBufMessage('Previously present field "2" with name "email" on message "User" was deleted.'),
      'User.email',
    );
    assert.equal(
      symbolFromBufMessage('Previously present RPC "DeleteUser" on service "Users" was deleted.'),
      'Users.DeleteUser',
    );
    assert.equal(symbolFromBufMessage('Previously present message "User" was deleted.'), 'User');
    // buf spells a rename without "with name", and quotes the field *number*
    // first — reading that as the symbol would search the repository for "2".
    assert.equal(
      symbolFromBufMessage('Field "2" on message "User" changed name from "email" to "mail".'),
      'User.mail',
    );
    assert.equal(
      symbolFromBufMessage('Field "1" with name "id" on message "User" changed type from "string" to "int32".'),
      'User.id',
    );
    assert.equal(symbolFromBufMessage('Something entirely unrecognised happened.'), null);
  });
});

/* ----------------------------------------------------------------- GraphQL */

const SDL_BEFORE = `
type Query {
  user(id: ID!): User
}

type User {
  id: ID!
  email: String
  status: Status
}

enum Status {
  ACTIVE
  BANNED
}
`;

describe('GraphQL SDL, via graphql-inspector', () => {
  const path = 'schema/api.graphql';

  async function gather(before: string, after: string, evidence: Record<string, unknown> = {}) {
    return gatherEvidence([], {
      config: DriftConfigSchema.parse({
        evidence: { graphql: true, graphqlSchemas: [path], ...evidence },
      }),
      logger,
      readRepoFile: repoWith(path, before, after),
      beforeSha: 'before',
      afterSha: 'after',
    });
  }

  test('a removed field becomes graphql-diff evidence', async () => {
    const after = SDL_BEFORE.replace('  email: String\n', '');
    const records = await gather(SDL_BEFORE, after);

    assert.equal(records.length, 1);
    const record = records[0]!;
    assert.equal(record.source, 'graphql-diff');
    assert.equal(record.dependency, path);
    assert.equal(record.weight, 1);
    assert.ok(
      record.findings?.some((f) => f.code === 'graphql-field-removed' && f.symbol === 'User.email'),
      `expected a field removal; got ${JSON.stringify(record.findings)}`,
    );
  });

  test('a newly required argument is classified as one', async () => {
    const after = SDL_BEFORE.replace('user(id: ID!): User', 'user(id: ID!, tenant: ID!): User');
    const records = await gather(SDL_BEFORE, after);

    assert.ok(
      records[0]?.findings?.some((f) => f.code === 'graphql-argument-now-required'),
      `expected a required-argument finding; got ${JSON.stringify(records[0]?.findings)}`,
    );
  });

  test('an added enum value is kept — dangerous, because exhaustive handling breaks', async () => {
    const after = SDL_BEFORE.replace('  BANNED\n', '  BANNED\n  PENDING\n');
    const records = await gather(SDL_BEFORE, after);

    assert.ok(
      records[0]?.findings?.some(
        (f) => f.code === 'graphql-enum-value-added' && f.symbol.includes('PENDING'),
      ),
      `expected the widened enum; got ${JSON.stringify(records[0]?.findings)}`,
    );
  });

  test('a purely additive field produces nothing', async () => {
    const after = SDL_BEFORE.replace('  email: String\n', '  email: String\n  createdAt: String\n');
    assert.deepEqual(await gather(SDL_BEFORE, after), [], 'adding a field does not break clients');
  });

  test('an unparseable document is a stated gap, not a clean result', async () => {
    const gaps: { reason: string }[] = [];
    const records = await gatherEvidence([], {
      config: DriftConfigSchema.parse({ evidence: { graphql: true, graphqlSchemas: [path] } }),
      logger,
      readRepoFile: repoWith(path, SDL_BEFORE, 'type User { id: ID!'),
      beforeSha: 'before',
      afterSha: 'after',
      onUnavailableSpec: (_path, reason) => gaps.push(reason),
    });

    assert.deepEqual(records, []);
    assert.equal(gaps[0]?.reason, 'parse-failed');
  });

  test('the provider is skipped when its flag is off', async () => {
    const after = SDL_BEFORE.replace('  email: String\n', '');
    assert.deepEqual(await gather(SDL_BEFORE, after, { graphql: false }), []);
  });

  test('only schema documents are handled', () => {
    assert.equal(graphqlSpecProvider.handles('schema/api.graphql', SDL_BEFORE), true);
    assert.equal(graphqlSpecProvider.handles('schema/api.gql', SDL_BEFORE), true);
    assert.equal(graphqlSpecProvider.handles('api/openapi.yaml', SDL_BEFORE), false);
    assert.equal(
      graphqlSpecProvider.handles('queries/user.graphql', '{ user(id: "1") { id } }'),
      false,
      'an operation document is not a contract to diff',
    );
  });

  test('one change type means two things, and criticality decides which', () => {
    assert.equal(codeForChangeType('FIELD_ARGUMENT_ADDED', 'BREAKING'), 'graphql-argument-now-required');
    assert.equal(codeForChangeType('FIELD_ARGUMENT_ADDED', 'DANGEROUS'), 'graphql-schema-changed');
    assert.equal(codeForChangeType('TYPE_KIND_CHANGED', 'BREAKING'), 'graphql-type-kind-changed');
    assert.equal(codeForChangeType('SOMETHING_ADDED_LATER', 'BREAKING'), 'graphql-schema-changed');
  });
});
