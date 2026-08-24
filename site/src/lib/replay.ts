import type { Candidate, RecordingTimelineEvent, ProgressTimelineEvent } from "./recordings";

export interface ReplayAccumulator {
  candidates: Map<string, Candidate>;
  order: string[];
  currentProgress?: ProgressTimelineEvent;
}

export function createReplayAccumulator(): ReplayAccumulator {
  return { candidates: new Map(), order: [] };
}

export function applyTimelineEvent(
  state: ReplayAccumulator,
  event: RecordingTimelineEvent,
): ReplayAccumulator {
  if (event.type === "progress") {
    state.currentProgress = event;
    return state;
  }

  if (event.type === "candidate-upsert") {
    if (!state.candidates.has(event.candidate.id)) {
      state.order.push(event.candidate.id);
    }
    state.candidates.set(event.candidate.id, event.candidate);
    return state;
  }

  state.candidates.delete(event.id);
  state.order = state.order.filter((id) => id !== event.id);
  return state;
}

export function visibleCandidates(state: ReplayAccumulator): Candidate[] {
  return state.order
    .map((id) => state.candidates.get(id))
    .filter((candidate): candidate is Candidate => candidate !== undefined);
}
