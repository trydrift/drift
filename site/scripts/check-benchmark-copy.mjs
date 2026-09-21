#!/usr/bin/env node
/**
 * No benchmark number may be typed into the pages that discuss benchmarks.
 *
 * This exists because it already happened once: the homepage and
 * `/benchmarks` both carried Roseau precision/recall figures as string
 * literals, and both went stale the moment a Java parser fix changed the real
 * result. `sync-benchmarks.mjs` reads every number from `eval/results/`, but
 * nothing stopped a future edit from writing `92/100` into a `<p>` next to it
 * — the generated data being correct proves nothing about the prose.
 *
 * The rule this enforces is structural, not a digit blocklist: a fraction
 * (`92/100`), a percentage (`91.1%`), or a three-decimal metric (`0.915`)
 * may only appear inside a JSX *expression* — `{...}` — in
 * `src/app/page.tsx`, `src/app/benchmarks/page.tsx` and
 * `src/lib/benchmark-narrative.ts`. Static JSX text between tags is where a
 * hand-typed number lives; an expression is where a value read out of
 * `results.json` lives. Prose that isn't shaped like a metric — "40-case
 * subset", "Five public corpora", a date — is untouched: this only matches
 * digit/digit, digit%, or 0.ddd shapes.
 *
 * `benchmark-narrative.ts` is exempted from the *content* rule (it is
 * expected to hold the constant strings that name rate labels and run ids)
 * but is asserted never to construct a `Rate` by hand — every numeric field
 * on `BenchmarkNarrative` must be produced by a `require*`/`fraction`/
 * `percent`/`formatRate` call from `./benchmarks`, never a literal object.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const siteSrc = join(here, '..', 'src');

const GUARDED_FILES = [
  join(siteSrc, 'app', 'page.tsx'),
  join(siteSrc, 'app', 'benchmarks', 'page.tsx'),
];

const NARRATIVE_MODULE = join(siteSrc, 'lib', 'benchmark-narrative.ts');

/** A fraction (`92/100`), a percentage (`91.1%` or `92%`), or a 3-decimal metric (`0.915`). */
const METRIC_SHAPES = [/\b\d+\s*\/\s*\d+\b/g, /\b\d+(?:\.\d+)?%/g, /\b0\.\d{3}\b/g];

/**
 * Every literal JSX text node in the source.
 *
 * A brace-depth scan (treat everything between `{` and `}` as an expression)
 * does not work here: `export default function Home() {` opens a brace that
 * has nothing to do with JSX, and a naive scan reads the entire function body
 * — including every real JSX text node inside it — as "inside an
 * expression", which hides exactly the literals this check exists to catch.
 *
 * JSX text is always the span between a tag or expression boundary and the
 * next one: right after `>` or `}`, up to the next `<` or `{`. That is true
 * regardless of what any earlier brace in the file belonged to, so this
 * matches text spans directly rather than trying to track nesting.
 */
function jsxTextSegments(source) {
  return [...source.matchAll(/(?:>|\})([^<>{}]*)(?:<|\{)/g)].map((match) => match[1]);
}

function findMetricLiterals(staticText) {
  const found = [];
  for (const pattern of METRIC_SHAPES) {
    for (const match of staticText.matchAll(pattern)) found.push(match[0]);
  }
  return found;
}

const failures = [];

for (const path of GUARDED_FILES) {
  const source = await readFile(path, 'utf8');
  const staticText = jsxTextSegments(source).join('\n');
  const literals = findMetricLiterals(staticText);
  if (literals.length > 0) {
    failures.push(
      `${path} has ${literals.length} hand-typed metric-shaped literal(s) outside a JSX expression: ` +
        `${[...new Set(literals)].join(', ')}. ` +
        `Read the value from loadBenchmarks()/buildNarrative() and interpolate it with {...} instead.`,
    );
  }
}

// benchmark-narrative.ts: every Rate-shaped value must come from a `require*`/
// `fraction`/`percent`/`formatRate` call, never a hand-built object literal
// with numerator/denominator/value fields.
const narrativeSource = await readFile(NARRATIVE_MODULE, 'utf8');
const handBuiltRate = /\{\s*numerator\s*:/.test(narrativeSource);
if (handBuiltRate) {
  failures.push(
    `${NARRATIVE_MODULE} constructs a rate object by hand (a "{ numerator: ...}" literal). ` +
      `Every rate must come from requireRate/requireBreakdownRate/requireClassification/requireConfusion, ` +
      `which throw when the run artifact backing it is missing.`,
  );
}

if (failures.length > 0) {
  console.error(`check-benchmark-copy:\n\n${failures.join('\n\n')}\n`);
  process.exit(1);
}

console.log(`check-benchmark-copy: no hand-typed benchmark metrics found in ${GUARDED_FILES.length} guarded file(s).`);
