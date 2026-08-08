import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';
function disableNetwork() {
    const block = () => {
        throw new Error('DRIFT_NETWORK_DISABLED');
    };
    // Patch before importing the package under test. This is not the primary
    // sandbox boundary; it is a deterministic network-denial shim for Node APIs
    // whose sockets are otherwise outside the permission model.
    http.request = block;
    http.get = block;
    https.request = block;
    https.get = block;
    net.connect = block;
    net.createConnection = block;
    dns.lookup = block;
    dns.resolve = block;
    globalThis.fetch = block;
}
async function main() {
    const casePath = process.argv[2];
    if (!casePath)
        throw new Error('missing case path');
    const spec = JSON.parse(await readFile(casePath, 'utf8'));
    if (!spec.network)
        disableNetwork();
    const beforeArgs = cloneJson(spec.args);
    const started = Date.now();
    try {
        const mod = await import(pathToFileURL(spec.modulePath).href);
        const target = mod[spec.exportName];
        if (typeof target !== 'function') {
            throw new TypeError(`Export ${spec.exportName} is not callable`);
        }
        const value = await target(...spec.args);
        write({
            status: 'returned',
            value: normalizeValue(value),
            mutations: diffArgs(beforeArgs, spec.args),
            durationMs: Date.now() - started,
        });
    }
    catch (err) {
        write({
            status: errorStatus(err),
            error: normalizeError(err),
            mutations: diffArgs(beforeArgs, spec.args),
            durationMs: Date.now() - started,
        });
    }
}
function write(value) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
}
function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}
function diffArgs(before, after) {
    const b = Array.isArray(before) ? before : [];
    const a = Array.isArray(after) ? after : [];
    const changed = [];
    for (let index = 0; index < Math.max(b.length, a.length); index += 1) {
        if (JSON.stringify(b[index]) !== JSON.stringify(a[index])) {
            changed.push({ index, before: normalizeValue(b[index]), after: normalizeValue(a[index]) });
        }
    }
    return changed;
}
function normalizeError(err) {
    const error = err;
    return {
        name: typeof error.name === 'string' ? error.name : 'Error',
        messageCategory: categorizeMessage(typeof error.message === 'string' ? error.message : ''),
        code: typeof error.code === 'string' ? error.code : undefined,
        resource: typeof error.resource === 'string'
            ? error.resource
            : undefined,
    };
}
function errorStatus(err) {
    const message = err?.message;
    return typeof message === 'string' && /permission|DRIFT_NETWORK_DISABLED/i.test(message) ? 'blocked' : 'threw';
}
function categorizeMessage(message) {
    if (/network|fetch|socket|DRIFT_NETWORK_DISABLED/i.test(message))
        return 'network';
    if (/permission|access|denied|not allowed/i.test(message))
        return 'permission';
    if (/timeout|timed out/i.test(message))
        return 'timeout';
    if (/invalid|expected|required|missing/i.test(message))
        return 'validation';
    return message ? 'other' : 'empty';
}
function normalizeValue(value) {
    if (value === null)
        return { type: 'null', value: null };
    if (Array.isArray(value))
        return { type: 'array', length: value.length, value: bounded(value) };
    switch (typeof value) {
        case 'string':
            return { type: 'string', length: value.length, value };
        case 'number':
        case 'boolean':
            return { type: typeof value, value };
        case 'undefined':
            return { type: 'undefined' };
        case 'object':
            return { type: 'object', keys: Object.keys(value).sort(), value: bounded(value) };
        default:
            return { type: typeof value };
    }
}
function bounded(value) {
    const json = JSON.stringify(value);
    if (json.length <= 1000)
        return value;
    return { truncatedHash: `${json.length}:${json.slice(0, 80)}` };
}
main().catch((err) => {
    write({ status: 'worker-failed', error: normalizeError(err), mutations: [], durationMs: 0 });
    process.exitCode = 1;
});
//# sourceMappingURL=behavioural-worker.js.map