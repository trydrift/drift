import { gunzipSync, inflateRawSync } from 'node:zlib';

/**
 * Reading source archives in-process, without unpacking them.
 *
 * Every other surface provider shells out to `tar` and works on a directory.
 * These two do not, for three reasons that all point the same way:
 *
 *   - **No toolchain.** `tar -xf` reading a zip is a BSD-tar behaviour. It is
 *     what macOS ships and what GNU/Linux does not, and a surface diff that
 *     silently works on a laptop and fails in CI is worse than one that never
 *     worked.
 *   - **Nothing is written to disk.** A zip entry may name `../../etc/passwd`,
 *     and the safest way to handle a path traversal in a third party's archive
 *     is never to join it onto a real directory.
 *   - **Only some of it is wanted.** A library's public headers are a few
 *     dozen files out of a few thousand; decompressing the rest is work spent
 *     on files nothing reads.
 *
 * Both readers return entries lazily-decompressed through a `read()` thunk, so
 * a caller that only wants `include/**.h` pays only for those.
 */

export interface ArchiveEntry {
  /** Path as recorded in the archive, `/`-separated. */
  path: string;
  size: number;
  /** Decompress this entry. Throws only on a corrupt archive. */
  read(): Buffer;
}

/** True when these bytes start with the gzip magic number. */
export function isGzip(data: Buffer): boolean {
  return data.length > 2 && data[0] === 0x1f && data[1] === 0x8b;
}

/** True when these bytes start with a PKZip local-file or central header. */
export function isZip(data: Buffer): boolean {
  return data.length > 4 && data[0] === 0x50 && data[1] === 0x4b;
}

/**
 * A ceiling on any single decompression this module performs, independent of
 * what an archive's own headers claim the decompressed size will be.
 *
 * Every archive this reads is a third party's bytes — a PyPI sdist, a GitHub
 * tag mirror, a Maven sources jar. A gzip or zip member's declared
 * uncompressed size is exactly that: declared, by the same untrusted archive,
 * and a crafted or merely unlucky one can expand to gigabytes from a
 * download that was well within `maxBytes` on the wire. Node's zlib accepts
 * `maxOutputLength` and aborts a sync decompression the moment it would be
 * exceeded, rather than fully allocating first and checking after — the
 * cheap, built-in equivalent of streaming with a running byte count.
 */
const DEFAULT_MAX_DECOMPRESSED_BYTES = 200 * 1024 * 1024;

export interface ReadArchiveOptions {
  /** Overrides `DEFAULT_MAX_DECOMPRESSED_BYTES` for this read. */
  maxDecompressedBytes?: number;
}

/**
 * Read any archive Drift downloads: zip, tar, or tar.gz.
 *
 * Sniffed from the bytes rather than the filename. A CDN that serves a `.zip`
 * URL as a gzipped tarball is not hypothetical, and the file's own first two
 * bytes are never wrong about what it is.
 */
export function readArchive(data: Buffer, options: ReadArchiveOptions = {}): ArchiveEntry[] {
  const maxDecompressedBytes = options.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES;
  if (isZip(data)) return readZip(data, { maxDecompressedBytes });
  return readTar(isGzip(data) ? gunzipSync(data, { maxOutputLength: maxDecompressedBytes }) : data);
}

/* ---------------- zip ---------------- */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

/**
 * A zip, read through its central directory.
 *
 * Reading the central directory rather than scanning for local file headers is
 * not a micro-optimisation: a local header may declare a size of zero and defer
 * the real one to a data descriptor after the compressed bytes, which cannot be
 * parsed without already knowing where the entry ends. The central directory
 * always has the true sizes.
 */
export function readZip(data: Buffer, options: ReadArchiveOptions = {}): ArchiveEntry[] {
  const maxDecompressedBytes = options.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES;
  const eocd = findEocd(data);
  if (eocd === -1) return [];

  const count = data.readUInt16LE(eocd + 10);
  let offset = data.readUInt32LE(eocd + 16);
  const entries: ArchiveEntry[] = [];

  for (let i = 0; i < count; i++) {
    if (offset + 46 > data.length) break;
    if (data.readUInt32LE(offset) !== CENTRAL_SIGNATURE) break;

    const method = data.readUInt16LE(offset + 10);
    const compressedSize = data.readUInt32LE(offset + 20);
    const uncompressedSize = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const localOffset = data.readUInt32LE(offset + 42);
    const path = data.toString('utf8', offset + 46, offset + 46 + nameLength);

    offset += 46 + nameLength + extraLength + commentLength;

    // A directory entry, which carries no content worth reading.
    if (path.endsWith('/')) continue;

    entries.push({
      path,
      size: uncompressedSize,
      read: () => readZipEntry(data, localOffset, method, compressedSize, maxDecompressedBytes),
    });
  }

  return entries;
}

function readZipEntry(
  data: Buffer,
  localOffset: number,
  method: number,
  compressedSize: number,
  maxDecompressedBytes: number,
): Buffer {
  // The local header repeats the name and extra fields at its own lengths,
  // which are not required to match the central directory's — so the start of
  // the data is computed from the local header, never from the central one.
  const nameLength = data.readUInt16LE(localOffset + 26);
  const extraLength = data.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  const body = data.subarray(start, start + compressedSize);

  // The central directory's `uncompressedSize` (used only for `size` above,
  // never for allocation) is exactly as untrusted as everything else this
  // archive declares about itself — `maxOutputLength` bounds what actually
  // comes out, regardless of what was claimed going in.
  if (method === 0) {
    if (body.length > maxDecompressedBytes) {
      throw new Error(`Stored zip entry exceeds the ${maxDecompressedBytes}-byte decompressed-size limit.`);
    }
    return Buffer.from(body);
  }
  if (method === 8) return inflateRawSync(body, { maxOutputLength: maxDecompressedBytes });
  throw new Error(`Unsupported zip compression method ${method}`);
}

/**
 * Locate the end-of-central-directory record.
 *
 * It sits at the very end of the file unless the archive has a comment, so the
 * search runs backwards over the 64 KB a comment can occupy rather than over
 * the whole file.
 */
function findEocd(data: Buffer): number {
  const earliest = Math.max(0, data.length - 0xffff - 22);
  for (let i = data.length - 22; i >= earliest; i--) {
    if (data.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

/* ---------------- tar ---------------- */

const BLOCK = 512;

/**
 * A tar, read block by block.
 *
 * Both long-name conventions are handled because both are in the wild and the
 * consequence of ignoring either is a header truncated to 100 characters —
 * which, for a C library, means losing exactly the deeply-nested
 * `include/foo/detail/bar.hpp` paths that the surface diff is looking for.
 */
export function readTar(data: Buffer): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let offset = 0;
  let pendingName: string | null = null;

  while (offset + BLOCK <= data.length) {
    const header = data.subarray(offset, offset + BLOCK);
    // Two consecutive zero blocks end the archive; one is enough to stop.
    if (header[0] === 0) break;

    const name = cstring(header.subarray(0, 100));
    const size = octal(header.subarray(124, 136));
    const typeFlag = String.fromCharCode(header[156] ?? 0);
    const prefix = cstring(header.subarray(345, 500));

    const start = offset + BLOCK;
    const end = start + size;
    offset = start + Math.ceil(size / BLOCK) * BLOCK;

    // GNU long name: this entry's *body* is the next entry's path.
    if (typeFlag === 'L') {
      pendingName = cstring(data.subarray(start, end));
      continue;
    }
    // A PAX extended header, whose `path=` record overrides the next name.
    if (typeFlag === 'x' || typeFlag === 'X') {
      pendingName = paxPath(data.subarray(start, end)) ?? pendingName;
      continue;
    }
    // Directories, links, and the GNU volume/sparse types carry no file bytes.
    if (typeFlag !== '0' && typeFlag !== '\0' && typeFlag !== '7') {
      pendingName = null;
      continue;
    }

    const path = pendingName ?? (prefix ? `${prefix}/${name}` : name);
    pendingName = null;
    if (!path) continue;

    const body = data.subarray(start, end);
    entries.push({ path, size, read: () => Buffer.from(body) });
  }

  return entries;
}

function cstring(buffer: Buffer): string {
  const end = buffer.indexOf(0);
  return buffer.toString('utf8', 0, end === -1 ? buffer.length : end).trim();
}

function octal(buffer: Buffer): number {
  const text = cstring(buffer).replace(/[^0-7]/g, '');
  return text ? Number.parseInt(text, 8) : 0;
}

/** `<len> path=<value>\n`, one record per line. */
function paxPath(body: Buffer): string | null {
  for (const line of body.toString('utf8').split('\n')) {
    const match = /^\d+\s+path=(.*)$/.exec(line);
    if (match) return match[1]!;
  }
  return null;
}
