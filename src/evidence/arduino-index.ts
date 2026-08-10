import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { httpCacheDir } from '../util/http.js';

/**
 * The Arduino Library Manager index.
 *
 * Every other registry Drift talks to answers a question about one package.
 * Arduino's does not: there is no per-library endpoint, and the only complete
 * source of truth is one 5 MB gzipped file listing all fifty thousand
 * published releases of all ten thousand libraries.
 *
 * That shape is the reason this file exists rather than another `fetchX` in
 * `registry.ts`. Downloading it per package would be absurd, and holding the
 * parsed 57 MB in memory for the life of a run would be rude, so it is
 * fetched once, reduced immediately to the four fields Drift actually reads,
 * and the reduction is cached on disk. A scan of a project with thirty
 * libraries costs one download on the first day and nothing after that.
 *
 * PlatformIO's registry is the obvious alternative and was tried first. It
 * has a clean per-package API and answers with only the *latest* version,
 * which makes it useless for the one question an upgrade scan asks — what
 * else has been published since the version this project pins. It is still
 * consulted, in `registry.ts`, for the repository URL of a library the
 * Arduino index does not carry.
 */

const INDEX_URL = 'https://downloads.arduino.cc/libraries/library_index.json.gz';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** What Drift keeps per library, out of the twenty fields the index carries. */
export interface ArduinoLibrary {
  name: string;
  /** Every published version, in index order. */
  versions: string[];
  /** `owner/repo`, when the library declares a GitHub repository. */
  githubRepo: string | null;
  website: string | null;
  description: string | null;
  /** Download URL of the release archive, per version. */
  archives: Record<string, string>;
}

/** Lowercased name -> library. Arduino names are case-insensitively unique. */
export type ArduinoIndex = Map<string, ArduinoLibrary>;

let inflight: Promise<ArduinoIndex | null> | null = null;

/**
 * The index, fetched at most once per process and once per day per machine.
 *
 * Returns `null` — never throws, never an empty map — when the index cannot be
 * had. An empty map would read as "this library does not exist", which is a
 * claim about Arduino rather than about the network.
 */
export async function arduinoIndex(): Promise<ArduinoIndex | null> {
  inflight ??= load();
  return inflight;
}

export async function arduinoLibrary(name: string): Promise<ArduinoLibrary | null> {
  const index = await arduinoIndex();
  return index?.get(name.toLowerCase()) ?? null;
}

/** Test seam: forget the process-lifetime memo. */
export function resetArduinoIndex(): void {
  inflight = null;
}

async function load(): Promise<ArduinoIndex | null> {
  const cached = await readCache();
  if (cached) return toMap(cached);

  const raw = await download();
  if (!raw) {
    // A stale cache beats no answer: a library's published history does not
    // change in a way that makes yesterday's copy misleading, and the
    // alternative is reporting every Arduino dependency as unknown because a
    // CDN was briefly unreachable.
    const stale = await readCache({ ignoreAge: true });
    return stale ? toMap(stale) : null;
  }

  const reduced = reduce(raw);
  await writeCache(reduced);
  return toMap(reduced);
}

async function download(): Promise<IndexDocument | null> {
  try {
    const response = await fetch(INDEX_URL, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      headers: { 'User-Agent': 'drift-bot/0.1 (+https://github.com/trydrift/drift)' },
    });
    if (!response.ok) return null;

    const body = Buffer.from(await response.arrayBuffer());
    // The CDN serves the file as `application/json` with no `Content-Encoding`,
    // so `fetch` does not decompress it and the bytes arrive gzipped. Sniffing
    // the magic number rather than trusting either fact keeps this working if
    // the CDN ever starts declaring the encoding.
    const json = body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body;
    return JSON.parse(json.toString('utf8')) as IndexDocument;
  } catch {
    return null;
  }
}

interface IndexDocument {
  libraries?: {
    name?: string;
    version?: string;
    repository?: string;
    website?: string;
    sentence?: string;
    url?: string;
  }[];
}

/**
 * One entry per release becomes one entry per library.
 *
 * The index is a flat list of releases — ArduinoJson appears in it eighty-odd
 * times — and the metadata on each is that release's, so the newest wins for
 * the repository and description fields.
 */
function reduce(doc: IndexDocument): ArduinoLibrary[] {
  const byName = new Map<string, ArduinoLibrary>();

  for (const entry of doc.libraries ?? []) {
    if (!entry.name || !entry.version) continue;
    const key = entry.name.toLowerCase();

    let library = byName.get(key);
    if (!library) {
      library = {
        name: entry.name,
        versions: [],
        githubRepo: null,
        website: null,
        description: null,
        archives: {},
      };
      byName.set(key, library);
    }

    if (!library.versions.includes(entry.version)) library.versions.push(entry.version);
    if (entry.url) library.archives[entry.version] = entry.url;
    library.githubRepo = githubSlug(entry.repository) ?? library.githubRepo;
    library.website = entry.website ?? library.website;
    library.description = entry.sentence ?? library.description;
  }

  return [...byName.values()];
}

function githubSlug(url: string | undefined): string | null {
  if (!url) return null;
  const match = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  return match ? `${match[1]}/${match[2]}` : null;
}

function toMap(libraries: readonly ArduinoLibrary[]): ArduinoIndex {
  return new Map(libraries.map((library) => [library.name.toLowerCase(), library]));
}

/* ---------------- disk cache ---------------- */

interface CacheFile {
  fetchedAt: number;
  libraries: ArduinoLibrary[];
}

function cachePath(): string | null {
  const dir = httpCacheDir();
  if (!dir) return null;
  const hash = createHash('sha256').update(INDEX_URL).digest('hex');
  return join(dir, `arduino-index-${hash.slice(0, 16)}.json`);
}

async function readCache(options: { ignoreAge?: boolean } = {}): Promise<ArduinoLibrary[] | null> {
  const path = cachePath();
  if (!path) return null;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as CacheFile;
    if (!Array.isArray(parsed.libraries)) return null;
    if (!options.ignoreAge && Date.now() - parsed.fetchedAt >= CACHE_TTL_MS) return null;
    return parsed.libraries;
  } catch {
    return null;
  }
}

async function writeCache(libraries: readonly ArduinoLibrary[]): Promise<void> {
  const path = cachePath();
  if (!path) return;
  try {
    await mkdir(join(path, '..'), { recursive: true });
    const file: CacheFile = { fetchedAt: Date.now(), libraries: [...libraries] };
    await writeFile(path, JSON.stringify(file), 'utf8');
  } catch {
    // Evidence is best-effort; a cache write must never fail a scan.
  }
}
