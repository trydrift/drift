export interface CandidateSummaryOperation {
  id: string;
  summary: string;
}

export const MAX_SUMMARY_OPERATIONS = 50;
export const MAX_SUMMARY_BYTES = 64 * 1024;
export const DETAIL_CHUNK_CHARACTERS = 16_000;

/** Removes one bounded batch; the map coalesces unsent revisions by candidate id. */
export function takeCandidateSummaryBatch(
  pending: Map<string, string>,
  maxOperations = MAX_SUMMARY_OPERATIONS,
  maxBytes = MAX_SUMMARY_BYTES,
): { operations: CandidateSummaryOperation[]; bytes: number } {
  const operations: CandidateSummaryOperation[] = [];
  let bytes = 0;
  for (const [id, summary] of pending) {
    const operationBytes = Buffer.byteLength(id) + Buffer.byteLength(summary) + 96;
    if (operationBytes > maxBytes) {
      pending.delete(id);
      continue;
    }
    if (operations.length >= maxOperations || (operations.length > 0 && bytes + operationBytes > maxBytes)) break;
    operations.push({ id, summary });
    bytes += operationBytes;
    pending.delete(id);
  }
  return { operations, bytes };
}

/** Chunks without splitting a surrogate pair; each default chunk is at most 64KiB UTF-8. */
export function chunkDetail(value: string, characters = DETAIL_CHUNK_CHARACTERS): string[] {
  if (value.length === 0) return [''];
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(value.length, offset + characters);
    const last = value.charCodeAt(end - 1);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) end--;
    chunks.push(value.slice(offset, end));
    offset = end;
  }
  return chunks;
}
