import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRecording, RECORDING_SCHEMA_VERSION } from "./recordings.ts";

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
