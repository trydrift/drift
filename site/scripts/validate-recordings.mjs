#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRecording } from './recording-validation.mjs';

const RECORDING_SCHEMA_VERSION = 2;
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'src', 'data');
const names = (await readdir(dataDir)).filter((name) => name.endsWith('.json')).sort();

let checked = 0;
let legacy = 0;
const failures = [];

for (const name of names) {
  let recording;
  try {
    recording = JSON.parse(await readFile(join(dataDir, name), 'utf8'));
  } catch (error) {
    failures.push(`${name}: could not parse (${error instanceof Error ? error.message : String(error)})`);
    continue;
  }

  // Pre-lifecycle artifacts are intentionally hidden by loadRecordings(). They
  // remain allowed until the refresh workflow regenerates them; every artifact
  // that is eligible to render must pass the strict lifecycle validator below.
  if (recording?.schemaVersion !== RECORDING_SCHEMA_VERSION) {
    legacy += 1;
    continue;
  }

  checked += 1;
  try {
    validateRecording(recording, RECORDING_SCHEMA_VERSION);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`Invalid site recording artifacts:\n${failures.map((failure) => `- ${failure}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Validated ${checked} lifecycle recording(s); ${legacy} legacy artifact(s) remain hidden.\n`);
}
