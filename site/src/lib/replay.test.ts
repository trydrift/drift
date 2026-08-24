import assert from "node:assert/strict";
import test from "node:test";
import { applyTimelineEvent, createReplayAccumulator, visibleCandidates } from "./replay";
import type { Candidate, RecordingTimelineEvent } from "./recordings";

const candidate = (id: string, status: string): Candidate => ({ id, status } as Candidate);
const upsert = (id: string, status: string): RecordingTimelineEvent => ({ type: "candidate-upsert", at: 100, candidate: candidate(id, status) });
const progress = (done: number): RecordingTimelineEvent => ({ type: "progress", at: 100, phase: "scan", detail: "", done, total: 100 });

function apply(events: RecordingTimelineEvent[]) {
  const state = createReplayAccumulator();
  for (const event of events) applyTimelineEvent(state, event);
  return state;
}

test("candidate updates replace values and preserve order", () => {
  const state = apply([upsert("A", "pending"), upsert("B", "checking"), upsert("A", "ready")]);
  assert.deepEqual(state.order, ["A", "B"]);
  assert.equal(visibleCandidates(state)[0]!.status, "ready");
});

test("drop removes candidates and re-upsert appends them", () => {
  const state = apply([upsert("A", "pending"), upsert("B", "ready"), { type: "candidate-drop", at: 100, id: "A" }, upsert("A", "ready")]);
  assert.deepEqual(state.order, ["B", "A"]);
});

test("progress does not create candidates and persists through candidate events", () => {
  const state = createReplayAccumulator();
  const p1 = progress(50);
  applyTimelineEvent(state, p1);
  for (const event of [upsert("A", "pending"), upsert("B", "ready"), { type: "candidate-drop", at: 100, id: "A" } as const]) {
    applyTimelineEvent(state, event);
    assert.equal(state.currentProgress, p1);
  }
  assert.equal(visibleCandidates(state).length, 1);
  const p2 = progress(100);
  applyTimelineEvent(state, p2);
  assert.equal(state.currentProgress, p2);
});

test("same-timestamp events retain array order", () => {
  const state = apply([upsert("A", "pending"), upsert("A", "checking"), upsert("A", "ready")]);
  assert.equal(visibleCandidates(state)[0]!.status, "ready");
});
