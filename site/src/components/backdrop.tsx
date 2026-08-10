"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

/**
 * The page's ground.
 *
 * A flat dot grid was the whole background, and it read like a wireframe that
 * never got finished — correct, cheap, and saying nothing about the product
 * standing on it. This replaces it with the career-ops signature: an animated
 * grain gradient in the corners over that same grid, in Drift's green.
 *
 * Three properties are load-bearing and are the reason this is a component
 * rather than a CSS class:
 *
 *   Deferred. The shader is `ssr: false` and mounts on browser idle, so it
 *   costs nothing before first paint. Until then the grid alone is the page,
 *   which is a complete-looking background rather than a hole.
 *
 *   Fixed, not scrolled. The glow sits behind the whole document at `fixed`
 *   position with content above it, so a long page keeps one continuous
 *   atmosphere instead of a decorated hero followed by a plain white run-out.
 *
 *   Faded downward. A mask takes the glow to nothing by the second screen. The
 *   demo panel and the pipeline are dense, and colour behind dense type is how
 *   a background stops being a background.
 *
 * Reduced motion gets the grid and a still gradient — never the shader.
 */

const GrainGradient = dynamic(
  () => import("@paper-design/shaders-react").then((m) => m.GrainGradient),
  { ssr: false },
);

/** Green in dark, a paler mint in light: the same hue at readable weight. */
const COLORS = {
  dark: ["#12A472", "#07543B", "#04241A00"],
  light: ["#A8EFD1", "#5CCB9E", "#DFF5EA00"],
} as const;

export function Backdrop() {
  const [show, setShow] = useState(false);
  const [dark, setDark] = useState(true);

  useEffect(() => {
    const readTheme = () => setDark(document.documentElement.classList.contains("dark"));
    readTheme();
    // The toggle announces itself, because the shader's colours are props
    // rather than CSS variables and nothing else would tell it the ground moved.
    window.addEventListener("themechange", readTheme);

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return () => window.removeEventListener("themechange", readTheme);
    }

    const idle = window as Window & {
      requestIdleCallback?: (cb: () => void, options?: { timeout?: number }) => number;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (typeof idle.requestIdleCallback === "function") {
      idle.requestIdleCallback(() => setShow(true), { timeout: 2000 });
    } else {
      timer = setTimeout(() => setShow(true), 400);
    }

    return () => {
      window.removeEventListener("themechange", readTheme);
      if (timer) clearTimeout(timer);
    };
  }, []);

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      {/* The still gradient. Present from the first paint and never removed, so
          the shader fades in over a ground of the same colour rather than
          arriving as a flash. */}
      <div className="absolute inset-x-0 top-0 h-[70vh] bg-glow-still" />

      {show && (
        <div className="absolute inset-x-0 top-0 h-[62vh] animate-fade-in-delayed opacity-55 [mask-image:radial-gradient(120%_90%_at_50%_0%,black,transparent_72%)]">
          <GrainGradient
            className="size-full"
            colors={[...(dark ? COLORS.dark : COLORS.light)]}
            colorBack="#00000000"
            softness={1}
            intensity={dark ? 0.2 : 0.13}
            noise={0.22}
            speed={0.4}
            shape="corners"
            minPixelRatio={1}
            maxPixelCount={1920 * 1080}
          />
        </div>
      )}

      {/* The grid last, so it lies *over* the glow the way graph paper lies on a
          desk — under the glow it disappeared into the bright corners. */}
      <div className="dot-bg absolute inset-0 [mask-image:linear-gradient(to_bottom,black,black_60%,transparent)]" />
    </div>
  );
}
