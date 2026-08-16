import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SpecChange, SpecOutcome, SpecProvider, SpecRequest } from './types.js';
import { unavailableSpec } from './types.js';

/**
 * Protobuf breaking-change detection, via `buf breaking`.
 *
 * Protobuf is the one contract format where "is this breaking?" is not a
 * judgement call. The wire format is defined by field *numbers*, so deleting
 * field 3 and reusing that number for something else has a specification-level
 * answer, not an opinion — and `buf` implements that specification as a rule
 * set maintained by the people who publish it. Reimplementing those rules here
 * would be Drift's guess at protobuf compatibility competing with the reference
 * implementation of it, which is the trade the surface providers already
 * decline for rustdoc and japicmp.
 *
 * So this shells out, exactly as the compiled-language surface providers do,
 * and treats a missing `buf` as an ordinary outcome with a stated remedy rather
 * than as a silent zero. Weighted 1.0: the `.proto` *is* the contract, and this
 * is a computed diff of two committed revisions of it.
 *
 * One limit, stated because it is invisible otherwise: Drift hands `buf` the
 * two revisions of the one configured file. A `.proto` that imports siblings
 * Drift was not asked to read will not compile, and that is reported as a
 * toolchain failure naming the import — not as "no breaking changes".
 */

const TOOL = 'buf breaking';

const REMEDY =
  'Install the Buf CLI (https://buf.build/docs/installation) so Drift can compare `.proto` revisions against the protobuf compatibility rules.';

/**
 * `buf` exits 100 when it has findings to report.
 *
 * Distinct from a real failure (a compile error, a bad flag), which uses the
 * ordinary non-zero codes — so this is the difference between "the contract
 * broke" and "the tool broke", and collapsing the two would report every
 * unparseable `.proto` as a clean comparison.
 */
const BUF_FINDINGS_EXIT_CODE = 100;

/** One line of `buf breaking --error-format=json`. */
export interface BufIssue {
  path: string;
  start_line?: number;
  start_column?: number;
  type: string;
  message: string;
}

export const protobufSpecProvider: SpecProvider = {
  id: 'protobuf',
  source: 'protobuf-diff',
  tool: TOOL,
  weight: 1.0,
  originClass: 'computed-artifact',
  config: { enabled: 'protobuf', paths: 'protobufSpecs' },

  handles(path: string, content: string): boolean {
    if (!path.endsWith('.proto')) return false;
    // A `.proto` states its syntax or declares something; requiring one of
    // those keeps a file that merely has the extension from being handed to a
    // compiler that will fail on it and report the failure as a gap.
    return /^\s*(syntax\s*=|package\s+|message\s+|service\s+|enum\s+)/m.test(content);
  },

  async compute(request: SpecRequest): Promise<SpecOutcome> {
    const version = await request.exec('buf', ['--version'], {
      timeoutMs: 20_000,
      ...(request.env ? { env: request.env } : {}),
    });
    if (version.failure === 'not-found' || version.code !== 0) {
      return unavailableSpec(
        TOOL,
        'tool-missing',
        `The Buf CLI is not installed or is not on PATH, so ${request.path} could not be checked against the protobuf compatibility rules.`,
        REMEDY,
      );
    }

    const after = join(request.workdir, 'after');
    const before = join(request.workdir, 'before');
    // The repo-relative path is preserved on both sides, because it is the
    // import path other files would use and it is what `buf` prints back.
    await writeProto(join(after, request.path), request.after);
    await writeProto(join(before, request.path), request.before);

    const result = await request.exec(
      'buf',
      ['breaking', after, '--against', before, '--error-format=json'],
      {
        cwd: request.workdir,
        timeoutMs: request.timeoutMs,
        ...(request.env ? { env: request.env } : {}),
      },
    );

    if (result.code !== 0 && result.code !== BUF_FINDINGS_EXIT_CODE) {
      const reason = (result.stderr || result.stdout || 'no output').trim().split('\n')[0] ?? '';
      return unavailableSpec(
        TOOL,
        'toolchain-failed',
        `\`buf breaking\` could not compare ${request.path}: ${reason}`,
        'If the file imports other `.proto` files, list them in `evidence.protobufSpecs` as well, or point Drift at a path `buf` can compile on its own.',
      );
    }

    let issues: BufIssue[];
    try {
      issues = parseBufBreaking(result.stdout);
    } catch (err) {
      return unavailableSpec(
        TOOL,
        'unexpected-output',
        `Drift could not read \`buf breaking\` output for ${request.path}: ${(err as Error).message}`,
      );
    }

    // A `.proto` that does not compile is reported by buf as an ordinary
    // finding — `type: "COMPILE"`, exit code 100, exactly like a real
    // incompatibility. Left alone, "imported file does not exist" would be
    // published as a breaking change to the contract, which is both false and
    // the most damaging shape of wrong this pipeline can produce. It is a fact
    // about what Drift was given to compare, so it is a gap.
    const compileError = issues.find((issue) => issue.type === 'COMPILE');
    if (compileError) {
      return unavailableSpec(
        TOOL,
        'toolchain-failed',
        `\`buf breaking\` could not compile ${request.path}: ${compileError.message}`,
        'If the file imports other `.proto` files, list them in `evidence.protobufSpecs` as well, or point Drift at a path `buf` can compile on its own.',
      );
    }

    return {
      available: true,
      changes: issues.filter(isRuleFinding).map(toSpecChange),
      tool: TOOL,
      weight: 1.0,
      locator: `${request.path} (buf breaking)`,
    };
  },

  codes: {
    'proto-field-removed': {
      kind: 'changed-endpoint',
      taxonomy: {
        // Two ways to bite, and both are real: code regenerated from the new
        // `.proto` stops compiling where it read the field, and a peer still
        // sending it on the wire is silently ignored.
        nature: 'protocol',
        detectability: ['compile-time', 'runtime-only'],
        scope: 'symbol',
        visibility: ['generated'],
      },
      remediation: ({ symbol }) =>
        `The protobuf field \`${symbol}\` was deleted. Regenerate this repository's stubs and update every reader and writer of that field. Do not reuse its field number for anything else — reserve it — and if the value is genuinely gone, propagate the absence rather than substituting a placeholder that could be mistaken for real data.`,
    },
    'proto-field-renamed': {
      kind: 'changed-endpoint',
      taxonomy: {
        nature: 'protocol',
        detectability: ['compile-time', 'runtime-only'],
        scope: 'symbol',
        visibility: ['generated'],
      },
      remediation: ({ symbol }) =>
        `The protobuf field \`${symbol}\` changed name. The wire encoding is unaffected — field numbers carry it — but generated accessors and any JSON representation are not. Regenerate the stubs and rename every use; check JSON payloads persisted or exchanged under the old name.`,
    },
    'proto-field-type-changed': {
      kind: 'changed-endpoint',
      taxonomy: {
        nature: 'data-schema',
        detectability: ['compile-time', 'runtime-only'],
        scope: 'symbol',
        visibility: ['generated'],
      },
      remediation: ({ symbol }) =>
        `The type or cardinality of the protobuf field \`${symbol}\` changed. Regenerate the stubs and update every construction and read of that field. A value already persisted or in flight was encoded under the old type — check that decoding it still means what the code assumes.`,
    },
    'proto-field-encoding-changed': {
      kind: 'behaviour-change',
      taxonomy: {
        nature: 'behaviour',
        detectability: ['runtime-only'],
        scope: 'symbol',
        visibility: ['generated'],
      },
      remediation: ({ symbol }) =>
        `An encoding option on the protobuf field \`${symbol}\` changed. Nothing about the schema's shape moved, so this compiles either way — what changes is the generated representation or the validation applied to the value. Review code that depends on that field's concrete representation.`,
    },
    'proto-oneof-removed': {
      kind: 'changed-endpoint',
      taxonomy: {
        nature: 'protocol',
        detectability: ['compile-time', 'runtime-only'],
        scope: 'type',
        visibility: ['generated'],
      },
      remediation: ({ symbol }) =>
        `The protobuf oneof \`${symbol}\` was deleted. Regenerate the stubs and rewrite every switch over its cases; a oneof's generated API has no drop-in replacement, so restructure the calling code rather than stubbing the accessor.`,
    },
    'proto-message-removed': {
      kind: 'removed-endpoint',
      taxonomy: {
        nature: 'protocol',
        detectability: ['compile-time', 'runtime-only'],
        scope: 'type',
        visibility: ['generated'],
      },
      remediation: ({ symbol }) =>
        `The protobuf message \`${symbol}\` no longer exists. Regenerate the stubs and migrate every use to the replacement message. If there is no replacement, leave the call site intact with a clearly-marked TODO and explain it in the PR description rather than inventing a local copy of the type.`,
    },
    'proto-enum-removed': {
      kind: 'removed-endpoint',
      taxonomy: {
        nature: 'protocol',
        detectability: ['compile-time', 'runtime-only'],
        scope: 'type',
        visibility: ['generated'],
      },
      remediation: ({ symbol }) =>
        `The protobuf enum \`${symbol}\` no longer exists. Regenerate the stubs and migrate every use to whatever now carries those values.`,
    },
    'proto-enum-value-removed': {
      kind: 'changed-endpoint',
      taxonomy: {
        nature: 'protocol',
        detectability: ['compile-time', 'runtime-only'],
        scope: 'symbol',
        visibility: ['generated'],
      },
      remediation: ({ symbol }) =>
        `The protobuf enum value \`${symbol}\` was deleted. Regenerate the stubs and map every use onto a still-supported value. A peer that still sends the removed number will decode as the unknown/unrecognised case — make sure that path is handled rather than falling through silently.`,
    },
    'proto-enum-value-renamed': {
      kind: 'changed-endpoint',
      taxonomy: {
        nature: 'protocol',
        detectability: ['compile-time', 'runtime-only'],
        scope: 'symbol',
        visibility: ['generated'],
      },
      remediation: ({ symbol }) =>
        `The protobuf enum value \`${symbol}\` changed name. The number is unchanged, so the wire encoding is safe; generated constants and JSON names are not. Regenerate the stubs and rename every use.`,
    },
    'proto-rpc-removed': {
      kind: 'removed-endpoint',
      taxonomy: {
        nature: 'protocol',
        detectability: ['compile-time', 'runtime-only'],
        scope: 'symbol',
        visibility: ['generated'],
      },
      remediation: ({ symbol }) =>
        `The RPC \`${symbol}\` no longer exists. Locate the client code that calls it and migrate to the replacement RPC. If there is no replacement, do not delete the feature — leave the call site intact with a clearly-marked TODO and explain it in the PR description.`,
    },
    'proto-rpc-signature-changed': {
      kind: 'changed-endpoint',
      taxonomy: {
        nature: 'protocol',
        detectability: ['compile-time', 'runtime-only'],
        scope: 'symbol',
        visibility: ['generated'],
      },
      remediation: ({ symbol }) =>
        `The signature of the RPC \`${symbol}\` changed — its request type, response type, or streaming shape. Regenerate the stubs and update every call site; a streaming change in particular rewrites the call's control flow, not just its types.`,
    },
    'proto-service-removed': {
      kind: 'removed-endpoint',
      taxonomy: {
        nature: 'protocol',
        detectability: ['compile-time', 'runtime-only'],
        scope: 'module',
        visibility: ['generated'],
      },
      remediation: ({ symbol }) =>
        `The service \`${symbol}\` no longer exists. Every client of it must be migrated to the replacement service; if there is none, leave the client intact with a clearly-marked TODO rather than deleting the feature.`,
    },
    'proto-package-changed': {
      kind: 'moved-export',
      taxonomy: {
        nature: 'packaging',
        detectability: ['compile-time'],
        scope: 'package',
        visibility: ['generated'],
      },
      remediation: ({ symbol }) =>
        `The protobuf package or a generated-code package option changed for \`${symbol}\`. The definitions still exist — their generated home moved. Regenerate the stubs and update the import paths; do not re-implement or stub the individual messages.`,
    },
    'proto-file-removed': {
      kind: 'removed-endpoint',
      taxonomy: {
        nature: 'packaging',
        detectability: ['compile-time'],
        scope: 'module',
        visibility: ['generated'],
      },
      remediation: ({ symbol }) =>
        `The \`.proto\` file \`${symbol}\` was deleted, taking everything it declared with it. Find where those definitions moved to and update the imports and generated-code references; if they were removed outright, say so in the PR description rather than recreating the file locally.`,
    },
    // The catch-all. `buf` maintains its rule set as protobuf's compatibility
    // guarantees evolve, so a rule this file has never heard of is an ordinary
    // event — reported with buf's own sentence, under a code that is honest
    // about being unclassified rather than guessed into the nearest neighbour.
    'proto-contract-changed': {
      kind: 'changed-endpoint',
      taxonomy: {
        nature: 'protocol',
        detectability: ['compile-time', 'runtime-only'],
        scope: 'symbol',
        visibility: ['generated'],
      },
      remediation: ({ symbol, detail }) =>
        `\`buf\` reports a compatibility break at \`${symbol}\`: ${detail} Regenerate this repository's stubs and update the code around that definition to match the new contract.`,
    },
  },
};

async function writeProto(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

/**
 * Parse `buf breaking --error-format=json`, which emits one object per line.
 *
 * Lines that are not objects are skipped rather than fatal: buf prints
 * diagnostics of its own on stdout in some versions, and one unrecognised line
 * must not discard a page of real findings.
 */
export function parseBufBreaking(stdout: string): BufIssue[] {
  const issues: BufIssue[] = [];

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;

    const issue = parsed as Partial<BufIssue>;
    if (typeof issue.type !== 'string' || typeof issue.message !== 'string') continue;

    issues.push({
      path: typeof issue.path === 'string' ? issue.path : '',
      type: issue.type,
      message: issue.message,
      ...(typeof issue.start_line === 'number' ? { start_line: issue.start_line } : {}),
      ...(typeof issue.start_column === 'number' ? { start_column: issue.start_column } : {}),
    });
  }

  return issues;
}

/**
 * Whether an issue is a compatibility rule firing, rather than buf reporting on
 * itself.
 *
 * buf's JSON stream carries both. Its own failures use SCREAMING names that are
 * not rule ids — `COMPILE` for a file that will not build, and the same channel
 * is used for plugin and configuration problems — and every one of those would
 * otherwise be published as a breaking change to the contract.
 */
function isRuleFinding(issue: BufIssue): boolean {
  return !NON_RULE_TYPES.has(issue.type);
}

const NON_RULE_TYPES = new Set(['COMPILE', 'PLUGIN_FAILURE', 'CONFIGURATION']);

function toSpecChange(issue: BufIssue): SpecChange {
  const line = issue.start_line ?? 0;
  return {
    code: codeForBufRule(issue.type),
    location: symbolFromBufMessage(issue.message) ?? `${issue.path}:${line}`,
    pointer: line > 0 ? `${issue.path}:${line}` : issue.path,
    // buf's own sentence, verbatim. It names the field number, the old type and
    // the new one — everything a reader needs to check the finding — and
    // paraphrasing it would only add a way to be wrong.
    detail: issue.message,
  };
}

/**
 * Map a `buf` rule id onto a Drift finding code.
 *
 * Matched on the rule's shape rather than by exhaustive list where the shape is
 * unambiguous (`*_NO_DELETE` is a removal in every category buf defines), so
 * a rule added upstream lands on the right code instead of on the catch-all.
 */
export function codeForBufRule(rule: string): string {
  switch (rule) {
    case 'FIELD_SAME_NAME':
    case 'FIELD_SAME_JSON_NAME':
      return 'proto-field-renamed';
    case 'ENUM_VALUE_SAME_NAME':
      return 'proto-enum-value-renamed';
    case 'FIELD_SAME_TYPE':
    case 'FIELD_SAME_LABEL':
    case 'FIELD_SAME_CARDINALITY':
    case 'FIELD_SAME_ONEOF':
    case 'FIELD_WIRE_COMPATIBLE_TYPE':
    case 'FIELD_WIRE_COMPATIBLE_CARDINALITY':
    case 'FIELD_WIRE_JSON_COMPATIBLE_TYPE':
    case 'FIELD_WIRE_JSON_COMPATIBLE_CARDINALITY':
      return 'proto-field-type-changed';
    case 'FIELD_SAME_CTYPE':
    case 'FIELD_SAME_JSTYPE':
    case 'FIELD_SAME_CPP_STRING_TYPE':
    case 'FIELD_SAME_UTF8_VALIDATION':
    case 'FIELD_SAME_JAVA_UTF8_VALIDATION':
    case 'FIELD_SAME_DEFAULT':
      return 'proto-field-encoding-changed';
    case 'RPC_SAME_REQUEST_TYPE':
    case 'RPC_SAME_RESPONSE_TYPE':
    case 'RPC_SAME_CLIENT_STREAMING':
    case 'RPC_SAME_SERVER_STREAMING':
    case 'RPC_SAME_IDEMPOTENCY_LEVEL':
      return 'proto-rpc-signature-changed';
    default:
      break;
  }

  if (/^FILE_SAME_(GO|JAVA|PHP|RUBY|CSHARP|OBJC|SWIFT)_/.test(rule)) return 'proto-package-changed';
  if (rule === 'FILE_SAME_PACKAGE' || rule === 'PACKAGE_NO_DELETE') return 'proto-package-changed';
  if (rule === 'FILE_NO_DELETE') return 'proto-file-removed';

  if (rule.endsWith('_NO_DELETE') || rule.includes('_NO_DELETE_UNLESS_')) {
    if (rule.startsWith('FIELD_')) return 'proto-field-removed';
    if (rule.startsWith('ENUM_VALUE_')) return 'proto-enum-value-removed';
    if (rule.startsWith('ENUM_') || rule.startsWith('PACKAGE_ENUM_')) return 'proto-enum-removed';
    if (rule.startsWith('ONEOF_')) return 'proto-oneof-removed';
    if (rule.startsWith('RPC_')) return 'proto-rpc-removed';
    if (rule.startsWith('SERVICE_') || rule.startsWith('PACKAGE_SERVICE_')) return 'proto-service-removed';
    if (rule.startsWith('MESSAGE_') || rule.startsWith('PACKAGE_MESSAGE_')) return 'proto-message-removed';
  }

  return 'proto-contract-changed';
}

/**
 * The definition a `buf` message is about, as a consumer would write it.
 *
 * Read out of buf's own prose, which is stable and quotes every name it uses:
 * *Previously present field "1" with name "email" on message "User" was
 * deleted.* There is no structured field carrying this — the JSON output gives
 * a file and a line — and a line number is not something a repository can be
 * searched for. When nothing recognisable is in the sentence the caller falls
 * back to `path:line`, which cites correctly and simply finds no impact sites.
 */
export function symbolFromBufMessage(message: string): string | null {
  const owner =
    /\bon (?:message|service|enum|oneof|extension) "([^"]+)"/.exec(message)?.[1] ??
    /\b(?:message|service|enum) "([^"]+)"/.exec(message)?.[1] ??
    null;

  const member =
    /\bwith name "([^"]+)"/.exec(message)?.[1] ??
    // A rename names both sides; the new one is what the repository will have
    // to be written against, so that is the one worth searching for.
    /\bchanged name from "[^"]+" to "([^"]+)"/.exec(message)?.[1] ??
    /\b(?:RPC|field|value|oneof) "([^"]+)"/i.exec(message)?.[1] ??
    null;

  // A field's own quoted token is its *number* in most buf messages ("Field
  // \"2\" on message \"User\"…"), and a bare "2" is not a symbol anything can
  // be searched for.
  const named = member && !/^\d+$/.test(member) ? member : null;

  if (owner && named) return `${owner}.${named}`;
  return owner ?? named;
}
