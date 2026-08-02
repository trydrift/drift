import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';

interface WorkerCase {
  modulePath: string;
  exportName: string;
  args: unknown[];
  network: boolean;
}

function disableNetwork(): void {
  const block = () => {
    throw new Error('DRIFT_NETWORK_DISABLED');
  };

  // Patch before importing the package under test. This is not the primary
  // sandbox boundary; it is a deterministic network-denial shim for Node APIs
  // whose sockets are otherwise outside the permission model.
  (http as { request?: unknown; get?: unknown }).request = block;
  (http as { request?: unknown; get?: unknown }).get = block;
  (https as { request?: unknown; get?: unknown }).request = block;
  (https as { request?: unknown; get?: unknown }).get = block;
  (net as { connect?: unknown; createConnection?: unknown }).connect = block;
  (net as { connect?: unknown; createConnection?: unknown }).createConnection = block;
  (dns as { lookup?: unknown; resolve?: unknown }).lookup = block;
  (dns as { lookup?: unknown; resolve?: unknown }).resolve = block;

  globalThis.fetch = block as never;
}

async function main(): Promise<void> {
  const casePath = process.argv[2];
  if (!casePath) throw new Error('missing case path');

  const spec = JSON.parse(await readFile(casePath, 'utf8')) as WorkerCase;
  if (!spec.network) disableNetwork();

  const beforeArgs = cloneJson(spec.args);
  const started = Date.now();

  try {
    const mod = await import(pathToFileURL(spec.modulePath).href);
    const target = (mod as Record<string, unknown>)[spec.exportName];
    if (typeof target !== 'function') {
      throw new TypeError(`Export ${spec.exportName} is not callable`);
    }

    const value = await (target as (...args: unknown[]) => unknown)(...spec.args);
    write({
      status: 'returned',
      value: normalizeValue(value),
      mutations: diffArgs(beforeArgs, spec.args),
      durationMs: Date.now() - started,
    });
  } catch (err) {
    write({
      status: errorStatus(err),
      error: normalizeError(err),
      mutations: diffArgs(beforeArgs, spec.args),
      durationMs: Date.now() - started,
    });
  }
}

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function cloneJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function diffArgs(before: unknown, after: unknown): unknown[] {
  const b = Array.isArray(before) ? before : [];
  const a = Array.isArray(after) ? after : [];
  const changed: unknown[] = [];
  for (let index = 0; index < Math.max(b.length, a.length); index += 1) {
    if (JSON.stringify(b[index]) !== JSON.stringify(a[index])) {
      changed.push({ index, before: normalizeValue(b[index]), after: normalizeValue(a[index]) });
    }
  }
  return changed;
}

function normalizeError(err: unknown): Record<string, unknown> {
  const error = err as { name?: unknown; message?: unknown; code?: unknown };
  return {
    name: typeof error.name === 'string' ? error.name : 'Error',
    messageCategory: categorizeMessage(typeof error.message === 'string' ? error.message : ''),
    code: typeof error.code === 'string' ? error.code : undefined,
    resource: typeof (error as { resource?: unknown }).resource === 'string'
      ? (error as { resource: string }).resource
      : undefined,
  };
}

function errorStatus(err: unknown): string {
  const message = (err as { message?: unknown })?.message;
  return typeof message === 'string' && /permission|DRIFT_NETWORK_DISABLED/i.test(message) ? 'blocked' : 'threw';
}

function categorizeMessage(message: string): string {
  if (/network|fetch|socket|DRIFT_NETWORK_DISABLED/i.test(message)) return 'network';
  if (/permission|access|denied|not allowed/i.test(message)) return 'permission';
  if (/timeout|timed out/i.test(message)) return 'timeout';
  if (/invalid|expected|required|missing/i.test(message)) return 'validation';
  return message ? 'other' : 'empty';
}

function normalizeValue(value: unknown): Record<string, unknown> {
  if (value === null) return { type: 'null', value: null };
  if (Array.isArray(value)) return { type: 'array', length: value.length, value: bounded(value) };
  switch (typeof value) {
    case 'string':
      return { type: 'string', length: value.length, value };
    case 'number':
    case 'boolean':
      return { type: typeof value, value };
    case 'undefined':
      return { type: 'undefined' };
    case 'object':
      return { type: 'object', keys: Object.keys(value as Record<string, unknown>).sort(), value: bounded(value) };
    default:
      return { type: typeof value };
  }
}

function bounded(value: unknown): unknown {
  const json = JSON.stringify(value);
  if (json.length <= 1000) return value;
  return { truncatedHash: `${json.length}:${json.slice(0, 80)}` };
}

main().catch((err) => {
  write({ status: 'worker-failed', error: normalizeError(err), mutations: [], durationMs: 0 });
  process.exitCode = 1;
});
