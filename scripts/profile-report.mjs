#!/usr/bin/env node
/**
 * Read a `DRIFT_PROFILE` dump and say where the time went.
 *
 * The one thing this does that a naive sum does not: every category is reduced
 * by *union of intervals*, not by adding durations up. A scan runs sixteen
 * things at once, so the cumulative time spent on HTTP is routinely four times
 * the length of the run — and optimising against that number leads directly to
 * shaving work that was fully overlapped and cost nothing. The "wall" column is
 * the honest one: how much shorter the run could get if this category became
 * instantaneous and nothing else changed.
 *
 * Usage:
 *   node scripts/profile-report.mjs drift-profile.json
 *   node scripts/profile-report.mjs a.json --compare b.json
 */

import { readFileSync } from 'node:fs';

/** Total length covered by a set of intervals, counting overlap once. */
function unionMs(spans) {
  if (spans.length === 0) return 0;
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let total = 0;
  let start = sorted[0].start;
  let end = sorted[0].end;
  for (const span of sorted.slice(1)) {
    if (span.start > end) {
      total += end - start;
      start = span.start;
      end = span.end;
    } else if (span.end > end) {
      end = span.end;
    }
  }
  return total + (end - start);
}

/** The most spans that were ever open at the same instant. */
function maxConcurrency(spans) {
  const edges = [];
  for (const span of spans) {
    edges.push([span.start, 1], [span.end, -1]);
  }
  // Closes before opens at the same timestamp, so two back-to-back spans do not
  // read as two concurrent ones.
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let open = 0;
  let peak = 0;
  for (const [, delta] of edges) {
    open += delta;
    if (open > peak) peak = open;
  }
  return peak;
}

function summarize(spans) {
  const byCat = new Map();
  for (const span of spans) {
    if (!byCat.has(span.cat)) byCat.set(span.cat, []);
    byCat.get(span.cat).push(span);
  }
  const rows = [];
  for (const [cat, group] of byCat) {
    rows.push({
      cat,
      count: group.length,
      cumulativeMs: Math.round(group.reduce((sum, s) => sum + (s.end - s.start), 0)),
      wallMs: Math.round(unionMs(group)),
      maxConcurrency: maxConcurrency(group),
      p50: Math.round(percentile(group, 0.5)),
      p95: Math.round(percentile(group, 0.95)),
    });
  }
  return rows.sort((a, b) => b.wallMs - a.wallMs);
}

function percentile(spans, q) {
  const durations = spans.map((s) => s.end - s.start).sort((a, b) => a - b);
  if (durations.length === 0) return 0;
  return durations[Math.min(durations.length - 1, Math.floor(q * durations.length))];
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function pad(text, width, right = false) {
  const s = String(text);
  return right ? s.padStart(width) : s.padEnd(width);
}

function render(doc, label) {
  const total = doc.durationMs;
  console.log(`\n${'='.repeat(78)}`);
  console.log(`${label}`);
  console.log(
    `total ${seconds(total)} · ${doc.machine.cpus} cores · node ${doc.machine.node} · peak RSS ${doc.peakRssMb} MB`,
  );
  if (Object.keys(doc.env).length > 0) console.log(`env: ${JSON.stringify(doc.env)}`);
  console.log('='.repeat(78));

  console.log(
    `\n${pad('category', 18)}${pad('count', 8, true)}${pad('wall', 10, true)}${pad('%run', 8, true)}` +
      `${pad('cumulative', 12, true)}${pad('conc', 7, true)}${pad('p50', 9, true)}${pad('p95', 9, true)}`,
  );
  console.log('-'.repeat(81));
  for (const row of summarize(doc.spans)) {
    console.log(
      pad(row.cat, 18) +
        pad(row.count, 8, true) +
        pad(seconds(row.wallMs), 10, true) +
        pad(`${((row.wallMs / total) * 100).toFixed(1)}%`, 8, true) +
        pad(seconds(row.cumulativeMs), 12, true) +
        pad(row.maxConcurrency, 7, true) +
        pad(`${row.p50}ms`, 9, true) +
        pad(`${row.p95}ms`, 9, true),
    );
  }

  // Within the categories where the name is the interesting axis — which host,
  // which command, which package — the same reduction one level down.
  for (const cat of ['phase', 'exec', 'http', 'verify', 'surface']) {
    const group = doc.spans.filter((s) => s.cat === cat);
    if (group.length === 0) continue;
    const byName = new Map();
    for (const span of group) {
      if (!byName.has(span.name)) byName.set(span.name, []);
      byName.get(span.name).push(span);
    }
    const rows = [...byName]
      .map(([name, spans]) => ({
        name,
        count: spans.length,
        wallMs: Math.round(unionMs(spans)),
        cumulativeMs: Math.round(spans.reduce((sum, s) => sum + (s.end - s.start), 0)),
      }))
      .sort((a, b) => b.wallMs - a.wallMs)
      .slice(0, 12);
    console.log(`\n  ${cat}:`);
    for (const row of rows) {
      console.log(
        `    ${pad(row.name, 34)}${pad(row.count, 7, true)}${pad(seconds(row.wallMs), 10, true)}` +
          `${pad(seconds(row.cumulativeMs), 12, true)} cumulative`,
      );
    }
  }

  const counters = Object.entries(doc.counters);
  if (counters.length > 0) {
    console.log('\n  counters:');
    for (const [name, value] of counters) console.log(`    ${pad(name, 34)}${pad(value, 10, true)}`);
  }
}

const [file, ...rest] = process.argv.slice(2);
if (!file) {
  console.error('usage: profile-report.mjs <profile.json> [--compare <other.json>]');
  process.exit(1);
}
render(JSON.parse(readFileSync(file, 'utf8')), file);

const compareAt = rest.indexOf('--compare');
if (compareAt >= 0 && rest[compareAt + 1]) {
  const other = rest[compareAt + 1];
  render(JSON.parse(readFileSync(other, 'utf8')), other);
}
