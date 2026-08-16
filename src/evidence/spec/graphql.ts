import { diff } from '@graphql-inspector/core';
import { buildSchema, type GraphQLSchema } from 'graphql';
import type { SpecChange, SpecOutcome, SpecProvider, SpecRequest } from './types.js';
import { unavailableSpec } from './types.js';

/**
 * GraphQL schema breaking-change detection, via `graphql-inspector`.
 *
 * The simplest of the contract providers: two SDL documents, a pure-JS diff, no
 * subprocess and no toolchain that can be missing. What it does share with the
 * others is the judgement about *authority* — graphql-inspector classifies each
 * change as breaking, dangerous or safe according to the same rules the GraphQL
 * community enforces in CI, and Drift translates that classification rather
 * than forming a second opinion about it.
 *
 * Two levels are kept:
 *
 *   - `BREAKING` — an existing valid query stops being valid.
 *   - `DANGEROUS` — the schema still accepts the query, but a response can now
 *     contain something the client has never seen. A new enum value is the
 *     canonical case, and it is the exact shape of the OpenAPI
 *     `response-enum-widened` finding: an exhaustive switch that used to be
 *     total silently stops being.
 *
 * `NON_BREAKING` changes are dropped. Flooding a plan with additions a reviewer
 * must filter is how trust in a tool like this dies.
 *
 * Weighted 1.0: the SDL *is* the contract, and this is a computed diff of two
 * committed revisions of it.
 */

const TOOL = 'graphql-inspector';

export const graphqlSpecProvider: SpecProvider = {
  id: 'graphql',
  source: 'graphql-diff',
  tool: TOOL,
  weight: 1.0,
  originClass: 'computed-artifact',
  config: { enabled: 'graphql', paths: 'graphqlSchemas' },

  handles(path: string, content: string): boolean {
    if (!/\.(graphql|graphqls|gql|sdl)$/i.test(path)) return false;
    // A schema *definition*, not an operation document: `query { ... }` files
    // share the extension and are not a contract this can diff.
    return /\b(type|interface|enum|union|input|scalar|schema|directive)\b/.test(content);
  },

  async compute(request: SpecRequest): Promise<SpecOutcome> {
    let before: GraphQLSchema;
    let after: GraphQLSchema;
    try {
      // `assumeValidSDL` — a schema that references a type defined in another
      // document is still a schema, and Drift was handed one file. Refusing to
      // diff a stitched schema's fragment would report "unparseable" for a
      // document that is simply not self-contained.
      before = buildSchema(request.before, { assumeValidSDL: true });
      after = buildSchema(request.after, { assumeValidSDL: true });
    } catch (err) {
      return unavailableSpec(
        TOOL,
        'parse-failed',
        `${request.path} could not be parsed as GraphQL SDL on both sides of this change: ${(err as Error).message}`,
      );
    }

    let changes: Awaited<ReturnType<typeof diff>>;
    try {
      changes = await diff(before, after);
    } catch (err) {
      return unavailableSpec(
        TOOL,
        'toolchain-failed',
        `graphql-inspector could not compare ${request.path}: ${(err as Error).message}`,
      );
    }

    const breaking: SpecChange[] = [];
    for (const change of changes) {
      const level = change.criticality?.level;
      if (level !== 'BREAKING' && level !== 'DANGEROUS') continue;

      const location = change.path ?? change.type;
      breaking.push({
        code: codeForChangeType(change.type, level),
        location,
        pointer: `${request.path}#${location}`,
        // graphql-inspector's own sentence, verbatim: it names the type, the
        // field and both sides of the change, which is what a reader checks
        // the finding against.
        detail: change.message,
      });
    }

    return {
      available: true,
      changes: breaking,
      tool: TOOL,
      weight: 1.0,
      locator: `${request.path} (GraphQL SDL)`,
    };
  },

  codes: {
    // A GraphQL schema is reached over the network by a query written as a
    // string, so nothing local compiles against it by default. Typed clients
    // generated from the schema do get a compile error — but Drift cannot know
    // from the SDL alone whether this repository generates one, so
    // `runtime-only` is the honest floor and `compile-time` is not claimed.
    'graphql-field-removed': {
      kind: 'changed-endpoint',
      taxonomy: {
        nature: 'protocol',
        detectability: ['runtime-only', 'external-observation'],
        scope: 'symbol',
        visibility: ['unknown'],
      },
      remediation: ({ symbol }) =>
        `The GraphQL field \`${symbol}\` was removed. Every query, mutation, or fragment in this repository that selects it will now be rejected outright — the whole document fails validation, not just that selection. Find those documents and migrate each to the replacement field; if there is none, propagate the absence rather than substituting a placeholder.`,
    },
    'graphql-input-field-removed': {
      kind: 'changed-endpoint',
      taxonomy: {
        nature: 'data-schema',
        detectability: ['runtime-only'],
        scope: 'symbol',
        visibility: ['unknown'],
      },
      remediation: ({ symbol }) =>
        `The GraphQL input field \`${symbol}\` no longer exists. Stop sending it: an unknown field on an input object fails validation, so every variable payload and inline argument that still carries it will be rejected.`,
    },
    'graphql-type-removed': {
      kind: 'removed-endpoint',
      taxonomy: {
        nature: 'protocol',
        detectability: ['runtime-only', 'external-observation'],
        scope: 'type',
        visibility: ['unknown'],
      },
      remediation: ({ symbol }) =>
        `The GraphQL type \`${symbol}\` no longer exists. Every fragment on it, every \`... on ${symbol}\` inline fragment, and every variable declared with it must be migrated. If there is no replacement type, leave the operation intact with a clearly-marked TODO and explain it in the PR description.`,
    },
    'graphql-type-kind-changed': {
      kind: 'type-change',
      taxonomy: {
        nature: 'type-contract',
        detectability: ['runtime-only'],
        scope: 'type',
        visibility: ['unknown'],
      },
      remediation: ({ symbol, detail }) =>
        `\`${symbol}\` changed kind: ${detail} Selections written against the old kind are no longer valid — an object's field selection does not survive becoming a union or a scalar. Rewrite each selection set for the new kind rather than adjusting it in place.`,
    },
    'graphql-field-type-changed': {
      kind: 'changed-endpoint',
      taxonomy: {
        nature: 'data-schema',
        detectability: ['runtime-only', 'external-observation'],
        scope: 'symbol',
        visibility: ['unknown'],
      },
      remediation: ({ symbol, detail }) =>
        `The type of the GraphQL field \`${symbol}\` changed: ${detail} Update the sub-selection and any client-side parsing of the value. A field that became nullable can now return null where the code assumed a value — handle that explicitly rather than asserting it away.`,
    },
    'graphql-input-field-type-changed': {
      kind: 'changed-endpoint',
      taxonomy: {
        nature: 'data-schema',
        detectability: ['runtime-only'],
        scope: 'symbol',
        visibility: ['unknown'],
      },
      remediation: ({ symbol, detail }) =>
        `The type of the GraphQL input field \`${symbol}\` changed: ${detail} Update every variable payload that sets it so the value sent matches the new type.`,
    },
    'graphql-argument-removed': {
      kind: 'changed-endpoint',
      taxonomy: {
        nature: 'protocol',
        detectability: ['runtime-only'],
        scope: 'symbol',
        visibility: ['unknown'],
      },
      remediation: ({ symbol }) =>
        `The GraphQL argument \`${symbol}\` was removed. Stop passing it — an unknown argument fails validation, so the whole operation is rejected, not just that argument.`,
    },
    'graphql-argument-type-changed': {
      kind: 'changed-endpoint',
      taxonomy: {
        nature: 'data-schema',
        detectability: ['runtime-only'],
        scope: 'symbol',
        visibility: ['unknown'],
      },
      remediation: ({ symbol, detail }) =>
        `The type of the GraphQL argument \`${symbol}\` changed: ${detail} Update the variable declarations and the values passed at every call site.`,
    },
    'graphql-argument-now-required': {
      kind: 'required-field-added',
      taxonomy: {
        nature: 'protocol',
        detectability: ['runtime-only'],
        scope: 'symbol',
        visibility: ['unknown'],
      },
      remediation: ({ symbol }) =>
        `\`${symbol}\` is now required and has no default. Supply it in every operation that reaches this field, using a value that preserves the previous behaviour; if the previous default is not documented, leave a TODO and flag it in the PR description rather than guessing.`,
    },
    'graphql-argument-default-changed': {
      kind: 'default-change',
      taxonomy: {
        // Compiles and validates either way. Only the value moved, which is the
        // class nothing short of running the query reveals.
        nature: 'behaviour',
        detectability: ['runtime-only'],
        scope: 'symbol',
        visibility: ['unknown'],
      },
      remediation: ({ symbol, detail }) =>
        `The default value of \`${symbol}\` changed: ${detail} Operations that omit it will silently behave differently. Pass the old value explicitly wherever the previous behaviour was intended.`,
    },
    'graphql-enum-value-removed': {
      kind: 'changed-endpoint',
      taxonomy: {
        nature: 'data-schema',
        detectability: ['runtime-only'],
        scope: 'symbol',
        visibility: ['unknown'],
      },
      remediation: ({ symbol }) =>
        `The GraphQL enum value \`${symbol}\` was removed. Find code that sends it and map it onto a still-supported value; code that only *reads* the enum should keep its fallback branch, since a stored value may still carry the old name.`,
    },
    'graphql-enum-value-added': {
      kind: 'changed-endpoint',
      taxonomy: {
        nature: 'data-schema',
        detectability: ['runtime-only', 'external-observation'],
        scope: 'symbol',
        visibility: ['unknown'],
      },
      remediation: ({ symbol }) =>
        `\`${symbol}\` is a new value this code has never seen returned. Add explicit handling; make sure exhaustive switches and mapping tables over that enum have a safe default rather than falling through silently.`,
    },
    'graphql-union-member-removed': {
      kind: 'changed-endpoint',
      taxonomy: {
        nature: 'protocol',
        detectability: ['runtime-only'],
        scope: 'type',
        visibility: ['unknown'],
      },
      remediation: ({ symbol, detail }) =>
        `A union or interface membership changed: ${detail} An \`... on ${symbol}\` fragment against a type that is no longer a member fails validation. Rewrite those fragments for the members the schema still declares.`,
    },
    'graphql-directive-removed': {
      kind: 'config-change',
      taxonomy: {
        nature: 'configuration',
        detectability: ['runtime-only'],
        scope: 'module',
        visibility: ['unknown'],
      },
      remediation: ({ symbol, detail }) =>
        `A GraphQL directive changed or was removed: ${detail} Every operation that applies \`${symbol}\` — or applies it where it is no longer allowed — fails validation. Remove or relocate those usages.`,
    },
    'graphql-root-type-changed': {
      kind: 'moved-export',
      taxonomy: {
        nature: 'protocol',
        detectability: ['runtime-only'],
        scope: 'module',
        visibility: ['unknown'],
      },
      remediation: ({ symbol, detail }) =>
        `The root operation type \`${symbol}\` changed: ${detail} Every operation of that kind is now rooted somewhere else — check that the top-level selections in this repository's documents still exist on the new root.`,
    },
    // The catch-all, for a change graphql-inspector classifies as breaking or
    // dangerous under a rule this file has not mapped. Honest about being
    // unclassified rather than guessed into the nearest neighbour.
    'graphql-schema-changed': {
      kind: 'changed-endpoint',
      taxonomy: {
        nature: 'protocol',
        detectability: ['runtime-only'],
        scope: 'symbol',
        visibility: ['unknown'],
      },
      remediation: ({ symbol, detail }) =>
        `graphql-inspector reports a breaking schema change at \`${symbol}\`: ${detail} Update the operations in this repository that touch it.`,
    },
  },
};

/**
 * Map a graphql-inspector change type onto a Drift finding code.
 *
 * The criticality level is passed because one change type means two different
 * things depending on it: `FIELD_ARGUMENT_ADDED` is breaking when the argument
 * is required and merely dangerous otherwise, and only the first is a "now
 * required" finding.
 */
export function codeForChangeType(type: string, level: 'BREAKING' | 'DANGEROUS'): string {
  switch (type) {
    case 'FIELD_REMOVED':
      return 'graphql-field-removed';
    case 'INPUT_FIELD_REMOVED':
      return 'graphql-input-field-removed';
    case 'TYPE_REMOVED':
      return 'graphql-type-removed';
    case 'TYPE_KIND_CHANGED':
      return 'graphql-type-kind-changed';
    case 'FIELD_TYPE_CHANGED':
      return 'graphql-field-type-changed';
    case 'INPUT_FIELD_TYPE_CHANGED':
      return 'graphql-input-field-type-changed';
    case 'FIELD_ARGUMENT_REMOVED':
    case 'DIRECTIVE_ARGUMENT_REMOVED':
      return 'graphql-argument-removed';
    case 'FIELD_ARGUMENT_TYPE_CHANGED':
    case 'DIRECTIVE_ARGUMENT_TYPE_CHANGED':
      return 'graphql-argument-type-changed';
    case 'FIELD_ARGUMENT_ADDED':
    case 'INPUT_FIELD_ADDED':
    case 'DIRECTIVE_ARGUMENT_ADDED':
      return level === 'BREAKING' ? 'graphql-argument-now-required' : 'graphql-schema-changed';
    case 'FIELD_ARGUMENT_DEFAULT_CHANGED':
    case 'INPUT_FIELD_DEFAULT_VALUE_CHANGED':
    case 'DIRECTIVE_ARGUMENT_DEFAULT_VALUE_CHANGED':
      return 'graphql-argument-default-changed';
    case 'ENUM_VALUE_REMOVED':
      return 'graphql-enum-value-removed';
    case 'ENUM_VALUE_ADDED':
      return 'graphql-enum-value-added';
    case 'UNION_MEMBER_REMOVED':
    case 'UNION_MEMBER_ADDED':
    case 'OBJECT_TYPE_INTERFACE_REMOVED':
      return 'graphql-union-member-removed';
    case 'DIRECTIVE_REMOVED':
    case 'DIRECTIVE_LOCATION_REMOVED':
    case 'DIRECTIVE_REPEATABLE_REMOVED':
      return 'graphql-directive-removed';
    case 'SCHEMA_QUERY_TYPE_CHANGED':
    case 'SCHEMA_MUTATION_TYPE_CHANGED':
    case 'SCHEMA_SUBSCRIPTION_TYPE_CHANGED':
      return 'graphql-root-type-changed';
    default:
      return 'graphql-schema-changed';
  }
}
