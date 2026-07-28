import { parse as parseYaml } from 'yaml';

/**
 * OpenAPI breaking-change detection.
 *
 * This is one of Drift's two *machine-verified* evidence sources (the other is
 * the TypeScript surface diff). Unlike changelog prose, a spec diff is ground
 * truth: if `DELETE /users/{id}` is gone from the new document, it is gone.
 * Findings from here carry the highest evidence weight and are the only ones
 * eligible for `high` confidence without corroboration.
 *
 * Directionality matters and is easy to get backwards. Drift analyses specs
 * from the perspective of a *consumer* calling the API:
 *
 *   - Tightening what the server accepts (new required field, narrowed enum on
 *     a request) breaks callers.
 *   - Loosening what the server returns (removed response field, widened enum
 *     on a response) breaks callers.
 *
 * The mirror cases are safe and are deliberately not reported.
 */

export type OpenApiChangeKind =
  | 'path-removed'
  | 'operation-removed'
  | 'parameter-removed'
  | 'parameter-now-required'
  | 'parameter-type-changed'
  | 'request-field-now-required'
  | 'request-field-type-changed'
  | 'request-enum-narrowed'
  | 'response-field-removed'
  | 'response-field-type-changed'
  | 'response-enum-widened'
  | 'response-status-removed'
  | 'security-added';

export interface OpenApiFinding {
  kind: OpenApiChangeKind;
  /** `METHOD /path` or `/path` for path-level findings. */
  location: string;
  /** JSON-pointer-ish path to the changed element, for precise citation. */
  pointer: string;
  detail: string;
}

interface AnySpec {
  openapi?: string;
  swagger?: string;
  paths?: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown>; securitySchemes?: Record<string, unknown> };
  definitions?: Record<string, unknown>;
  security?: unknown[];
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/** Parse a spec from JSON or YAML text. Returns `null` if it isn't one. */
export function parseSpec(content: string): AnySpec | null {
  let doc: unknown;
  try {
    doc = content.trim().startsWith('{') ? JSON.parse(content) : parseYaml(content);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  const spec = doc as AnySpec;
  // Require a version marker so we don't try to diff arbitrary YAML.
  if (!spec.openapi && !spec.swagger) return null;
  return spec;
}

/** Compare two specs and return only consumer-breaking differences. */
export function diffSpecs(oldContent: string, newContent: string): OpenApiFinding[] {
  const before = parseSpec(oldContent);
  const after = parseSpec(newContent);
  if (!before || !after) return [];

  const findings: OpenApiFinding[] = [];
  const oldPaths = before.paths ?? {};
  const newPaths = after.paths ?? {};

  for (const [path, oldPathItem] of Object.entries(oldPaths)) {
    const newPathItem = newPaths[path];

    if (!newPathItem) {
      findings.push({
        kind: 'path-removed',
        location: path,
        pointer: `#/paths/${escapePointer(path)}`,
        detail: `Path \`${path}\` no longer exists. Every request to it will 404.`,
      });
      continue;
    }

    for (const method of HTTP_METHODS) {
      const oldOp = oldPathItem[method] as Record<string, unknown> | undefined;
      if (!oldOp) continue;

      const newOp = newPathItem[method] as Record<string, unknown> | undefined;
      const location = `${method.toUpperCase()} ${path}`;
      const pointer = `#/paths/${escapePointer(path)}/${method}`;

      if (!newOp) {
        findings.push({
          kind: 'operation-removed',
          location,
          pointer,
          detail: `Operation \`${location}\` was removed.`,
        });
        continue;
      }

      diffParameters(oldOp, newOp, before, after, location, pointer, findings);
      diffRequestBody(oldOp, newOp, before, after, location, pointer, findings);
      diffResponses(oldOp, newOp, before, after, location, pointer, findings);
      diffSecurity(oldOp, newOp, location, pointer, findings);
    }
  }

  return findings;
}

interface Parameter {
  name?: string;
  in?: string;
  required?: boolean;
  schema?: Record<string, unknown>;
  type?: string;
  $ref?: string;
}

function diffParameters(
  oldOp: Record<string, unknown>,
  newOp: Record<string, unknown>,
  beforeSpec: AnySpec,
  afterSpec: AnySpec,
  location: string,
  pointer: string,
  findings: OpenApiFinding[],
): void {
  const oldParams = indexParameters(oldOp.parameters, beforeSpec);
  const newParams = indexParameters(newOp.parameters, afterSpec);

  for (const [key, oldParam] of oldParams) {
    const newParam = newParams.get(key);
    if (!newParam) {
      // Only *required* parameter removals are unambiguously breaking; an
      // optional one disappearing usually means the server now ignores it.
      if (oldParam.required) {
        findings.push({
          kind: 'parameter-removed',
          location,
          pointer: `${pointer}/parameters/${key}`,
          detail: `Required parameter \`${oldParam.name}\` (in: ${oldParam.in}) was removed.`,
        });
      }
      continue;
    }

    if (!oldParam.required && newParam.required) {
      findings.push({
        kind: 'parameter-now-required',
        location,
        pointer: `${pointer}/parameters/${key}`,
        detail: `Parameter \`${newParam.name}\` (in: ${newParam.in}) is now required. Calls omitting it will be rejected.`,
      });
    }

    const oldType = schemaType(oldParam.schema ?? { type: oldParam.type });
    const newType = schemaType(newParam.schema ?? { type: newParam.type });
    if (oldType && newType && oldType !== newType) {
      findings.push({
        kind: 'parameter-type-changed',
        location,
        pointer: `${pointer}/parameters/${key}`,
        detail: `Parameter \`${newParam.name}\` changed type from \`${oldType}\` to \`${newType}\`.`,
      });
    }

    const oldEnum = enumValues(oldParam.schema);
    const newEnum = enumValues(newParam.schema);
    const removed = oldEnum.filter((v) => !newEnum.includes(v));
    if (oldEnum.length && newEnum.length && removed.length) {
      findings.push({
        kind: 'request-enum-narrowed',
        location,
        pointer: `${pointer}/parameters/${key}`,
        detail: `Parameter \`${newParam.name}\` no longer accepts: ${removed.map((v) => `\`${v}\``).join(', ')}.`,
      });
    }
  }
}

function diffRequestBody(
  oldOp: Record<string, unknown>,
  newOp: Record<string, unknown>,
  beforeSpec: AnySpec,
  afterSpec: AnySpec,
  location: string,
  pointer: string,
  findings: OpenApiFinding[],
): void {
  const oldSchema = resolve(bodySchema(oldOp), beforeSpec);
  const newSchema = resolve(bodySchema(newOp), afterSpec);
  if (!oldSchema || !newSchema) return;

  const oldRequired = new Set(requiredFields(oldSchema));
  const newRequired = requiredFields(newSchema);

  for (const field of newRequired) {
    if (!oldRequired.has(field)) {
      findings.push({
        kind: 'request-field-now-required',
        location,
        pointer: `${pointer}/requestBody/${field}`,
        detail: `Request body field \`${field}\` is now required.`,
      });
    }
  }

  for (const [name, oldType, newType] of changedPropertyTypes(oldSchema, newSchema, beforeSpec, afterSpec)) {
    findings.push({
      kind: 'request-field-type-changed',
      location,
      pointer: `${pointer}/requestBody/${name}`,
      detail: `Request body field \`${name}\` changed type from \`${oldType}\` to \`${newType}\`.`,
    });
  }
}

function diffResponses(
  oldOp: Record<string, unknown>,
  newOp: Record<string, unknown>,
  beforeSpec: AnySpec,
  afterSpec: AnySpec,
  location: string,
  pointer: string,
  findings: OpenApiFinding[],
): void {
  const oldResponses = (oldOp.responses ?? {}) as Record<string, Record<string, unknown>>;
  const newResponses = (newOp.responses ?? {}) as Record<string, Record<string, unknown>>;

  for (const [status, oldResponse] of Object.entries(oldResponses)) {
    // Only success responses are contractual for a consumer; error shapes
    // changing is noisy and rarely what breaks a client's happy path.
    if (!/^2\d\d$/.test(status)) continue;

    const newResponse = newResponses[status];
    if (!newResponse) {
      findings.push({
        kind: 'response-status-removed',
        location,
        pointer: `${pointer}/responses/${status}`,
        detail: `Success response \`${status}\` was removed from \`${location}\`.`,
      });
      continue;
    }

    const oldSchema = resolve(contentSchema(oldResponse), beforeSpec);
    const newSchema = resolve(contentSchema(newResponse), afterSpec);
    if (!oldSchema || !newSchema) continue;

    const oldProps = properties(oldSchema);
    const newProps = properties(newSchema);

    for (const name of Object.keys(oldProps)) {
      if (!(name in newProps)) {
        findings.push({
          kind: 'response-field-removed',
          location,
          pointer: `${pointer}/responses/${status}/${name}`,
          detail: `Response field \`${name}\` is no longer returned by \`${location}\`.`,
        });
      }
    }

    for (const [name, oldType, newType] of changedPropertyTypes(oldSchema, newSchema, beforeSpec, afterSpec)) {
      findings.push({
        kind: 'response-field-type-changed',
        location,
        pointer: `${pointer}/responses/${status}/${name}`,
        detail: `Response field \`${name}\` changed type from \`${oldType}\` to \`${newType}\`.`,
      });
    }

    // A response enum gaining members breaks exhaustive consumer switches.
    for (const [name, oldProp] of Object.entries(oldProps)) {
      const newProp = newProps[name];
      if (!newProp) continue;
      const oldEnum = enumValues(oldProp);
      const newEnum = enumValues(newProp);
      const added = newEnum.filter((v) => !oldEnum.includes(v));
      if (oldEnum.length && added.length) {
        findings.push({
          kind: 'response-enum-widened',
          location,
          pointer: `${pointer}/responses/${status}/${name}`,
          detail: `Response field \`${name}\` can now return new values: ${added.map((v) => `\`${v}\``).join(', ')}. Exhaustive handling of this field must be updated.`,
        });
      }
    }
  }
}

function diffSecurity(
  oldOp: Record<string, unknown>,
  newOp: Record<string, unknown>,
  location: string,
  pointer: string,
  findings: OpenApiFinding[],
): void {
  const oldSecurity = (oldOp.security ?? []) as Record<string, unknown>[];
  const newSecurity = (newOp.security ?? []) as Record<string, unknown>[];

  // An operation that previously permitted anonymous access (`security: []`)
  // and now demands a scheme is a hard break for existing callers.
  const wasOpen = oldSecurity.length === 0 || oldSecurity.some((s) => Object.keys(s).length === 0);
  const isOpen = newSecurity.length === 0 || newSecurity.some((s) => Object.keys(s).length === 0);

  if (wasOpen && !isOpen && newSecurity.length > 0) {
    const schemes = [...new Set(newSecurity.flatMap((s) => Object.keys(s)))];
    findings.push({
      kind: 'security-added',
      location,
      pointer: `${pointer}/security`,
      detail: `\`${location}\` now requires authentication (${schemes.join(', ')}).`,
    });
  }
}

/* ---------- schema helpers ---------- */

function indexParameters(raw: unknown, spec: AnySpec): Map<string, Parameter> {
  const out = new Map<string, Parameter>();
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    const param = resolve(entry as Record<string, unknown>, spec) as Parameter | null;
    if (!param?.name) continue;
    // Key on name+location: `id` in the path and `id` in the query are distinct.
    out.set(`${param.in ?? 'query'}:${param.name}`, param);
  }
  return out;
}

function bodySchema(op: Record<string, unknown>): Record<string, unknown> | null {
  const body = op.requestBody as Record<string, unknown> | undefined;
  if (!body) return null;
  return contentSchema(body);
}

/** Pull the schema out of a `content` map, preferring JSON media types. */
function contentSchema(holder: Record<string, unknown>): Record<string, unknown> | null {
  const content = holder.content as Record<string, { schema?: Record<string, unknown> }> | undefined;
  if (!content) return (holder.schema as Record<string, unknown>) ?? null;

  const jsonKey = Object.keys(content).find((k) => k.includes('json')) ?? Object.keys(content)[0];
  if (!jsonKey) return null;
  return content[jsonKey]?.schema ?? null;
}

/**
 * Resolve a local `$ref`. External refs are out of scope: Drift compares two
 * documents it was handed and has no fetcher for arbitrary sibling files, so
 * an unresolvable ref yields `null` and that element is simply not diffed.
 */
function resolve(
  schema: Record<string, unknown> | null | undefined,
  spec: AnySpec,
  depth = 0,
): Record<string, unknown> | null {
  if (!schema) return null;
  if (depth > 10) return schema; // cyclic $ref guard

  const ref = schema.$ref;
  if (typeof ref !== 'string') return schema;
  if (!ref.startsWith('#/')) return null;

  const segments = ref.slice(2).split('/').map(unescapePointer);
  let node: unknown = spec;
  for (const segment of segments) {
    if (!node || typeof node !== 'object') return null;
    node = (node as Record<string, unknown>)[segment];
  }

  if (!node || typeof node !== 'object') return null;
  return resolve(node as Record<string, unknown>, spec, depth + 1);
}

function properties(schema: Record<string, unknown>): Record<string, Record<string, unknown>> {
  // Flatten a single level of allOf, which is how most generators express
  // inheritance. Deeper composition is left alone rather than half-handled.
  const own = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const allOf = schema.allOf;
  if (!Array.isArray(allOf)) return own;

  const merged: Record<string, Record<string, unknown>> = { ...own };
  for (const part of allOf) {
    if (part && typeof part === 'object') {
      Object.assign(merged, (part as Record<string, unknown>).properties ?? {});
    }
  }
  return merged;
}

function requiredFields(schema: Record<string, unknown>): string[] {
  const own = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const allOf = Array.isArray(schema.allOf) ? schema.allOf : [];
  const inherited = allOf.flatMap((part) => {
    const r = (part as Record<string, unknown>)?.required;
    return Array.isArray(r) ? (r as string[]) : [];
  });
  return [...new Set([...own, ...inherited])];
}

function changedPropertyTypes(
  oldSchema: Record<string, unknown>,
  newSchema: Record<string, unknown>,
  beforeSpec: AnySpec,
  afterSpec: AnySpec,
): [string, string, string][] {
  const out: [string, string, string][] = [];
  const oldProps = properties(oldSchema);
  const newProps = properties(newSchema);

  for (const [name, oldProp] of Object.entries(oldProps)) {
    const newProp = newProps[name];
    if (!newProp) continue;

    const oldType = schemaType(resolve(oldProp, beforeSpec));
    const newType = schemaType(resolve(newProp, afterSpec));
    if (oldType && newType && oldType !== newType) out.push([name, oldType, newType]);
  }
  return out;
}

function schemaType(schema: Record<string, unknown> | null | undefined): string | null {
  if (!schema) return null;
  const type = schema.type;
  if (typeof type === 'string') {
    if (type === 'array') {
      const items = schema.items as Record<string, unknown> | undefined;
      const itemType = typeof items?.type === 'string' ? items.type : 'unknown';
      return `array<${itemType}>`;
    }
    return type;
  }
  if (Array.isArray(type)) return type.join('|');
  return null;
}

function enumValues(schema: Record<string, unknown> | null | undefined): string[] {
  const values = schema?.enum;
  return Array.isArray(values) ? values.map((v) => String(v)) : [];
}

/* ---------- JSON pointer escaping (RFC 6901) ---------- */

function escapePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function unescapePointer(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}
