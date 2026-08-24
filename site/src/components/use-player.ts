"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Candidate, ProgressTimelineEvent, Recording, RecordingTimelineEvent } from "@/lib/recordings";
import { applyTimelineEvent, createReplayAccumulator, visibleCandidates } from "@/lib/replay";
import type { ReplayAccumulator } from "@/lib/replay";

/**
 * Replay a recorded analysis at the speed it actually ran.
 *
 * The clock is `performance.now()` deltas accumulated per frame, not
 * `Date.now()` compared against a start stamp. That matters because the player
 * can be paused, restarted, and switched between recordings: an absolute start
 * time has to be corrected on every one of those transitions, and each
 * correction is a chance to drift a few frames out. Accumulating elapsed time
 * has nothing to correct.
 *
 * Events are consumed with a moving cursor rather than by filtering the whole
 * array each frame. Deno's recording is 372 events long; re-scanning it sixty
 * times a second to answer "which ones have happened yet" is work the cursor
 * does once.
 */

export const REPLAY_SPEEDS = [1, 2, 4] as const;

export type PlayerPhase = "idle" | "running" | "done";
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

export interface PlayerState {
  phase: PlayerPhase;
  /** Milliseconds into the recording. */
  elapsed: number;
  /** Index one past the last event that has played. */
  cursor: number;
  candidates: Candidate[];
  currentProgress?: ProgressTimelineEvent;
}

/**
 * How long a replay should take, whatever it is a replay of.
 *
 * The recordings are whole-repository runs, and they are wildly different
 * lengths because the repositories are: Supabase's twelve packages take
 * fourteen seconds and GitLab's three hundred and fifty-four take
 * twenty-three minutes. One fixed multiplier cannot serve both — 3× turns
 * Supabase into a five-second flicker and GitLab into something nobody will
 * ever watch the end of.
 *
 * So the rate is derived per recording, to land every replay in about the same
 * window. A uniform multiplier preserves the *shape* of the timing exactly —
 * the pauses, the bursts, the one package that stalls behind a changelog fetch
 * — which is the part that makes it read as real. Only the clock is scaled,
 * and the panel prints both the true duration and the rate underneath, so the
 * compression is stated rather than implied.
 */
const TARGET_MS = 26_000;

/**
 * A short recording plays at life speed — 1× is the floor, not a compromise.
 * Elasticsearch's fourteen packages really do finish in seven seconds, and
 * padding that out to fill a window would be inventing time the run did not
 * take. The ceiling is where the panel stops being readable.
 */
const MIN_SPEED = 1;
const MAX_SPEED = 90;

/** Never leave a viewer looking at a still panel for longer than this. */
const MAX_GAP_MS = 900;

export function usePlayer(recording: Recording) {
  const [state, setState] = useState<PlayerState>({
    phase: "idle",
    elapsed: 0,
    cursor: 0,
    candidates: [],
  });

  const frame = useRef(0);
  const last = useRef(0);
  const elapsed = useRef(0);
  const replayState = useRef<ReplayAccumulator>(createReplayAccumulator());
  const stateCursor = useRef(0);

  /**
   * The timeline the player actually walks.
   *
   * Real runs contain gaps — a slow changelog fetch, a registry that took four
   * seconds — and reproducing one faithfully means several seconds of a panel
   * that appears frozen. So gaps are compressed to `MAX_GAP_MS` while the
   * ordering and the relative rhythm of everything else is left alone. The
   * unevenness survives; the dead air does not.
   */
  const timeline = useRef<{ at: number; index: number }[]>([]);
  const duration = useRef(0);
  const [baseSpeed, setBaseSpeed] = useState(MIN_SPEED);
  const [speedMultiplier, setSpeedMultiplierState] = useState<ReplaySpeed>(1);
  const speedRef = useRef(MIN_SPEED);

  useEffect(() => {
    let clock = 0;
    let previous = 0;
    timeline.current = recording.timeline.map((event, index) => {
      clock += Math.min(event.at - previous, MAX_GAP_MS);
      previous = event.at;
      return { at: clock, index };
    });
    // A beat at the end, so the final event is legible before the summary
    // replaces the running state.
    duration.current = clock + 600;

    // Derived from the *compressed* timeline rather than from the recording's
    // wall-clock duration: dead air has already been taken out, and scaling
    // against a number that still contains it would race through the events
    // that are left.
    const rate = Math.round(
      Math.min(MAX_SPEED, Math.max(MIN_SPEED, duration.current / TARGET_MS)),
    );
    setBaseSpeed(rate);
    speedRef.current = rate * speedMultiplier;
  }, [recording, speedMultiplier]);

  const setSpeedMultiplier = useCallback((next: ReplaySpeed) => {
    setSpeedMultiplierState(next);
    speedRef.current = baseSpeed * next;
  }, [baseSpeed]);

  const stop = useCallback(() => {
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0;
  }, []);

  /** Jump straight to the finished state, showing every result at once. */
  const complete = useCallback(() => {
    stop();
    elapsed.current = duration.current;
    setState({
      phase: "done",
      elapsed: duration.current,
      cursor: recording.timeline.length,
      candidates: recording.candidates,
      currentProgress: replayState.current.currentProgress,
    });
  }, [recording, stop]);

  const start = useCallback(() => {
    stop();
    elapsed.current = 0;
    stateCursor.current = 0;
    replayState.current = createReplayAccumulator();

    // Motion here carries information — it is how the page shows that the work
    // takes time and happens in stages — so a viewer who has asked for less of
    // it gets the full result immediately rather than an animation they did not
    // consent to or a panel that never resolves.
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      complete();
      return;
    }

    last.current = performance.now();
    setState({
      phase: "running",
      elapsed: 0,
      cursor: 0,
      candidates: [],
      currentProgress: undefined,
    });

    const tick = (now: number) => {
      const delta = now - last.current;
      last.current = now;
      elapsed.current += delta * speedRef.current;
      const at = elapsed.current;

      if (at >= duration.current) {
        complete();
        return;
      }

      let cursor = stateCursor.current;
      const marks = timeline.current;
      // Cheap because `marks` is sorted and the player only moves forward:
      // this walks from the previous cursor, not from zero.
      while (cursor < marks.length && marks[cursor]!.at <= at) {
        const event = recording.timeline[marks[cursor]!.index] as RecordingTimelineEvent;
        replayState.current = applyTimelineEvent(replayState.current, event);
        cursor += 1;
      }
      stateCursor.current = cursor;

      setState({
        phase: "running",
        elapsed: at,
        cursor,
        candidates: recording.legacy ? [] : visibleCandidates(replayState.current),
        currentProgress: replayState.current.currentProgress,
      });

      frame.current = requestAnimationFrame(tick);
    };

    frame.current = requestAnimationFrame(tick);
  }, [complete, recording, stop]);

  const reset = useCallback(() => {
    stop();
    elapsed.current = 0;
    stateCursor.current = 0;
    replayState.current = createReplayAccumulator();
    setState({
      phase: "idle",
      elapsed: 0,
      cursor: 0,
      candidates: [],
      currentProgress: undefined,
    });
  }, [stop]);

  // Switching recordings mid-run must not leave the previous one's frames
  // writing into the new one's state.
  useEffect(() => {
    reset();
    return stop;
  }, [recording, reset, stop]);

  return {
    state,
    start,
    reset,
    complete,
    currentProgress: state.currentProgress,
    speed: baseSpeed * speedMultiplier,
    speedMultiplier,
    setSpeedMultiplier,
  };
}
