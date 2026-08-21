import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const EVIDENCE_SNAPSHOT_VERSION = 'drift-external-evidence-v1';

export type EvidenceMode = 'capture' | 'replay' | 'fresh';

export interface EvidenceSnapshotEntry {
  key: string;
  method: string;
  url: string;
  status: number;
  statusText: string;
  headers: [string, string][];
  bodySha256: string;
  bodyBytes: number;
}

export interface EvidenceSnapshotManifest {
  version: typeof EVIDENCE_SNAPSHOT_VERSION;
  mode: 'capture';
  caseId: string;
  createdAt: string;
  entries: EvidenceSnapshotEntry[];
  snapshotHash: string;
}

export interface EvidenceRunMetadata {
  mode: EvidenceMode;
  snapshotPath: string | null;
  snapshotHash: string | null;
  requestCount: number;
}

export interface EvidenceSnapshotOptions {
  mode: EvidenceMode;
  caseId: string;
  caseDir: string;
  blobDir: string;
}

export class EvidenceSnapshotError extends Error {}

export function safeEvidenceCaseId(caseId: string): string {
  return caseId.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 180) || 'case';
}

export async function withEvidenceSnapshot<T>(
  options: EvidenceSnapshotOptions,
  work: () => Promise<T>,
): Promise<{ value: T; evidence: EvidenceRunMetadata }> {
  await mkdir(options.caseDir, { recursive: true });
  await mkdir(options.blobDir, { recursive: true });
  const snapshotPath = join(options.caseDir, 'snapshot.json');

  return options.mode === 'replay'
    ? replayEvidence({ ...options, snapshotPath }, work)
    : captureEvidence({ ...options, snapshotPath }, work);
}

async function captureEvidence<T>(
  options: EvidenceSnapshotOptions & { snapshotPath: string },
  work: () => Promise<T>,
): Promise<{ value: T; evidence: EvidenceRunMetadata }> {
  const original = globalThis.fetch;
  const entries = new Map<string, EvidenceSnapshotEntry>();

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = requestShape(input, init);
    const response = await original(input, init);
    const body = Buffer.from(await response.arrayBuffer());
    const bodySha256 = sha256(body);
    await writeFile(join(options.blobDir, bodySha256), body);

    if (!entries.has(request.key)) {
      entries.set(request.key, {
        key: request.key,
        method: request.method,
        url: request.url,
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers.entries()].sort(([a], [b]) => a.localeCompare(b)),
        bodySha256,
        bodyBytes: body.length,
      });
    }

    return new Response(new Uint8Array(body), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as typeof fetch;

  try {
    const value = await work();
    const manifest = finalizeManifest(options.caseId, [...entries.values()]);
    await writeFile(options.snapshotPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return {
      value,
      evidence: {
        mode: options.mode,
        snapshotPath: options.snapshotPath,
        snapshotHash: manifest.snapshotHash,
        requestCount: manifest.entries.length,
      },
    };
  } finally {
    globalThis.fetch = original;
  }
}

async function replayEvidence<T>(
  options: EvidenceSnapshotOptions & { snapshotPath: string },
  work: () => Promise<T>,
): Promise<{ value: T; evidence: EvidenceRunMetadata }> {
  const manifest = JSON.parse(await readFile(options.snapshotPath, 'utf8')) as EvidenceSnapshotManifest;
  verifyManifest(manifest);
  const byKey = new Map(manifest.entries.map((entry) => [entry.key, entry]));

  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = requestShape(input, init);
    const entry = byKey.get(request.key);
    if (!entry) {
      throw new EvidenceSnapshotError(`No captured evidence for ${request.method} ${request.url}; replay refused to fetch live upstream content.`);
    }

    const body = await readFile(join(options.blobDir, entry.bodySha256));
    const actual = sha256(body);
    if (actual !== entry.bodySha256) {
      throw new EvidenceSnapshotError(`Captured evidence blob ${entry.bodySha256} was replaced or corrupted; actual sha256 is ${actual}.`);
    }

    return new Response(new Uint8Array(body), {
      status: entry.status,
      statusText: entry.statusText,
      headers: entry.headers,
    });
  }) as typeof fetch;

  try {
    const value = await work();
    return {
      value,
      evidence: {
        mode: 'replay',
        snapshotPath: options.snapshotPath,
        snapshotHash: manifest.snapshotHash,
        requestCount: manifest.entries.length,
      },
    };
  } finally {
    globalThis.fetch = original;
  }
}

function requestShape(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): { method: string; url: string; key: string } {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (typeof input === 'object' && !(input instanceof URL) ? input.method : undefined) ?? 'GET').toUpperCase();
  const headers = headerEntries(init?.headers ?? (typeof input === 'object' && !(input instanceof URL) ? input.headers : undefined));
  const key = sha256(JSON.stringify({ method, url, headers }));
  return { method, url, key };
}

function headerEntries(headers: NonNullable<Parameters<typeof fetch>[1]>['headers'] | undefined): [string, string][] {
  if (!headers) return [];
  return [...new Headers(headers).entries()]
    .filter(([key]) => /auth|token/i.test(key) || key.toLowerCase() === 'accept')
    .sort(([a], [b]) => a.localeCompare(b));
}

function finalizeManifest(caseId: string, entries: EvidenceSnapshotEntry[]): EvidenceSnapshotManifest {
  const sorted = entries.sort((a, b) => a.key.localeCompare(b.key));
  const withoutHash = {
    version: EVIDENCE_SNAPSHOT_VERSION as typeof EVIDENCE_SNAPSHOT_VERSION,
    mode: 'capture' as const,
    caseId,
    createdAt: new Date().toISOString(),
    entries: sorted,
  };
  return {
    ...withoutHash,
    snapshotHash: sha256(JSON.stringify({ ...withoutHash, createdAt: null })),
  };
}

function verifyManifest(manifest: EvidenceSnapshotManifest): void {
  if (manifest.version !== EVIDENCE_SNAPSHOT_VERSION) {
    throw new EvidenceSnapshotError(`Unsupported evidence snapshot version ${String(manifest.version)}.`);
  }
  const expected = sha256(
    JSON.stringify({
      version: manifest.version,
      mode: manifest.mode,
      caseId: manifest.caseId,
      createdAt: null,
      entries: manifest.entries,
    }),
  );
  if (manifest.snapshotHash !== expected) {
    throw new EvidenceSnapshotError(`Evidence snapshot hash mismatch for ${manifest.caseId}: expected ${manifest.snapshotHash}, computed ${expected}.`);
  }
}

function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}
