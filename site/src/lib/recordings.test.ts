import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeRecording,
  RECORDING_SCHEMA_VERSION,
  shortDate,
} from "./recordings.ts";

test("accepts a recording with the current candidate lifecycle schema", () => {
  const recording = normalizeRecording({
    schemaVersion: RECORDING_SCHEMA_VERSION,
    timeline: [],
    candidates: [],
  });
  assert.ok(recording);
});

test("rejects a pre-lifecycle recording instead of inventing candidate IDs", () => {
  const recording = normalizeRecording({ events: [], candidates: [{ name: "lucide-react" }] });
  assert.equal(recording, null);
});

test("shortDate is stable across runtimes and time zones", () => {
  assert.equal(shortDate("2026-09-01T23:30:00.000Z"), "1 Sep 2026");
});
