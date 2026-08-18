#!/usr/bin/env node
/**
 * Diff two benchmark summaries: the timings, and — the part that matters — the
 * semantic fingerprint of what Drift concluded.
 *
 * A performance change is only a performance change if the answer did not move.
 * Every differing field is printed individually rather than reduced to a
 * pass/fail, because "the output differs" is the beginning of an investigation,
 * not the end of one.
 */
import { readFileSync } from 'node:fs';

const [beforePath, afterPath] = process.argv.slice(2);
const before = JSON.parse(readFileSync(beforePath, 'utf8'));
const after = JSON.parse(readFileSync(afterPath, 'utf8'));

const s = (ms) => `${(ms / 1000).toFixed(1)}s`;
const pct = (a, b) => `${(((a - b) / a) * 100).toFixed(1)}%`;

let totalBefore = 0;
let totalAfter = 0;
let differences = 0;

console.log(
  `${'target'.padEnd(12)}${'eco'.padEnd(10)}${'before'.padStart(9)}${'after'.padStart(9)}` +
    `${'change'.padStart(9)}${'cpu b→a'.padStart(16)}${'rss b→a'.padStart(14)}  output`,
);
console.log('-'.repeat(96));

for (const b of before) {
  const a = after.find((r) => r.id === b.id);
  if (!a) continue;
  totalBefore += b.wallMs;
  totalAfter += a.wallMs;

  const same = JSON.stringify(b.fingerprint) === JSON.stringify(a.fingerprint);
  const pinned = b.commit === a.commit;
  if (!same) differences += 1;

  console.log(
    b.id.padEnd(12) +
      String(b.ecosystem).padEnd(10) +
      s(b.wallMs).padStart(9) +
      s(a.wallMs).padStart(9) +
      pct(b.wallMs, a.wallMs).padStart(9) +
      `${b.userCpuMs + b.systemCpuMs}→${a.userCpuMs + a.systemCpuMs}ms`.padStart(16) +
      `${b.maxRssMb}→${a.maxRssMb}MB`.padStart(14) +
      `  ${same ? 'identical' : 'DIFFERS'}${pinned ? '' : ' (COMMIT MOVED)'}`,
  );

  if (!same) {
    const byId = new Map(a.fingerprint.map((c) => [c.id, c]));
    for (const candidate of b.fingerprint) {
      const other = byId.get(candidate.id);
      if (!other) {
        console.log(`    MISSING AFTER: ${candidate.id}`);
        continue;
      }
      for (const key of Object.keys(candidate)) {
        const x = JSON.stringify(candidate[key]);
        const y = JSON.stringify(other[key]);
        if (x !== y) console.log(`    ${candidate.id} · ${key}\n      before: ${x}\n      after:  ${y}`);
      }
      byId.delete(candidate.id);
    }
    for (const id of byId.keys()) console.log(`    NEW AFTER: ${id}`);
  }
}

console.log('-'.repeat(96));
console.log(`${'TOTAL'.padEnd(22)}${s(totalBefore).padStart(9)}${s(totalAfter).padStart(9)}${pct(totalBefore, totalAfter).padStart(9)}`);
console.log(differences === 0 ? '\nOutput identical on every target.' : `\n${differences} target(s) with semantic differences — investigate each.`);
