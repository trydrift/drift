"use client";

import { useEffect, useReducer, useRef, useState } from "react";

/**
 * The install block, typing out the CLI's actual commands.
 *
 * The static version of this ended on `drift analyze` and a blinking cursor,
 * which told a visitor there was one command. There are four, and the least
 * obvious — `outdated` — is the one people are surprised to find, so the block
 * cycles through all of them and says what each one does underneath.
 *
 * Every string here is a command the CLI really accepts (`src/cli.ts`), and
 * that invariant is enforced: `site/scripts/check-commands.mjs` parses the
 * CLI's own usage text and fails the build if this list names anything the CLI
 * does not. It is asserted rather than merely claimed because it stopped being
 * true — `audit` was advertised here for a while after the command had been
 * removed, which is precisely the species of decoration this site exists to
 * avoid.
 */

interface Command {
  args: string;
  says: string;
}

const COMMANDS: Command[] = [
  { args: "analyze", says: "The full pipeline against your working tree. Writes nothing, needs no token." },
  { args: "outdated", says: "Every direct dependency, and what each upgrade would actually cost you." },
  { args: "fix", says: "Applies one commit unit — codemod, community recipe, or agent, in that order." },
  { args: "pr", says: "Opens the pull request, one reviewable commit per concern." },
];

/** Milliseconds per keystroke, and how long a finished command sits there. */
const TYPE_MS = 55;
const DELETE_MS = 28;
const HOLD_MS = 2200;

type Phase = "typing" | "holding" | "deleting";

interface State {
  index: number;
  typed: number;
  phase: Phase;
}

function next(state: State): State {
  const command = COMMANDS[state.index]!.args;

  if (state.phase === "typing") {
    return state.typed < command.length
      ? { ...state, typed: state.typed + 1 }
      : { ...state, phase: "holding" };
  }
  if (state.phase === "holding") return { ...state, phase: "deleting" };
  return state.typed > 0
    ? { ...state, typed: state.typed - 1 }
    : { index: (state.index + 1) % COMMANDS.length, typed: 0, phase: "typing" };
}

function delayFor(state: State): number {
  if (state.phase === "holding") return HOLD_MS;
  if (state.phase === "deleting") return DELETE_MS;
  // A human types unevenly. A perfectly regular interval is the one detail
  // that makes a typewriter read as an animation rather than as someone
  // working, and it costs one line to avoid.
  return TYPE_MS + Math.random() * 45;
}

export function Terminal() {
  const [state, advance] = useReducer(next, { index: 0, typed: 0, phase: "typing" });
  const [animate, setAnimate] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Reduced motion gets the first command, complete and still. The point of
  // the block is the command; the typing is decoration, and decoration is
  // exactly what that preference is asking to be spared.
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setAnimate(!query.matches);
    const onChange = () => setAnimate(!query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!animate) return;
    timer.current = setTimeout(advance, delayFor(state));
    return () => clearTimeout(timer.current);
  }, [animate, state]);

  const command = COMMANDS[state.index]!;
  const shown = animate ? command.args.slice(0, state.typed) : command.args;

  return (
    <div className="mt-6">
      <div className="overflow-x-auto rounded-xl border border-border bg-[var(--pre-bg)] p-4">
        <pre className="font-mono text-[13px] leading-relaxed text-foreground">
          <span className="text-faint">$ </span>npm install -g @usedrift/cli{"\n"}
          <span className="text-faint">$ </span>drift{" "}
          <span className="text-brand-text">{shown}</span>
          <span className="cli-cursor text-brand"> ▋</span>
        </pre>
      </div>

      {/*
        Fixed height and `aria-live="off"`. The caption changes every couple of
        seconds; announcing each one would make a screen reader unusable on
        this page, and letting the box resize would shove the footer up and
        down forever. The full list is in the cards above this block, so
        nothing here is the only copy of anything.
      */}
      <p
        aria-live="off"
        className="mt-2.5 flex min-h-[2.5rem] items-start text-[13px] leading-relaxed text-muted"
      >
        <span key={command.args} className="animate-rise">
          <code className="font-mono text-brand-text">drift {command.args}</code> — {command.says}
        </span>
      </p>
    </div>
  );
}
