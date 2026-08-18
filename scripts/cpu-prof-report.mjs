#!/usr/bin/env node
/**
 * Self-time totals from a `--cpu-prof` profile, by function and by file.
 *
 * V8 writes samples and a call tree; what is wanted here is the flat answer —
 * which function bodies the CPU was actually inside — because that is the one a
 * scan's synchronous hot spots show up in. Node's own tooling renders the tree.
 */
import { readFileSync } from 'node:fs';

const profile = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const byId = new Map(profile.nodes.map((n) => [n.id, n]));

// `timeDeltas[i]` is the time attributed to `samples[i]`, in microseconds.
const self = new Map();
for (const [at, id] of profile.samples.entries()) {
  self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[at] ?? 0));
}

const rows = [];
for (const [id, us] of self) {
  const node = byId.get(id);
  if (!node) continue;
  const { functionName, url, lineNumber } = node.callFrame;
  rows.push({
    name: functionName || '(anonymous)',
    where: `${(url || '').replace(/^file:\/\/.*?\/(dist|node_modules)\//, '$1/')}:${lineNumber + 1}`,
    ms: us / 1000,
  });
}

const total = rows.reduce((a, r) => a + r.ms, 0);
console.log(`total sampled CPU: ${(total / 1000).toFixed(1)}s\n`);

const merge = (key) => {
  const by = new Map();
  for (const r of rows) by.set(key(r), (by.get(key(r)) ?? 0) + r.ms);
  return [...by].sort((a, b) => b[1] - a[1]);
};

console.log('by function (self time):');
for (const [name, ms] of merge((r) => `${r.name}  ${r.where}`).slice(0, 25)) {
  console.log(`  ${(ms / 1000).toFixed(2).padStart(7)}s  ${((ms / total) * 100).toFixed(1).padStart(5)}%  ${name}`);
}

console.log('\nby file:');
for (const [file, ms] of merge((r) => r.where.replace(/:\d+$/, '')).slice(0, 18)) {
  console.log(`  ${(ms / 1000).toFixed(2).padStart(7)}s  ${((ms / total) * 100).toFixed(1).padStart(5)}%  ${file}`);
}
