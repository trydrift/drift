"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * Wraps a CLI command so clicking it copies the exact string.
 *
 * Every command shown on this page is one the CLI really accepts (see
 * `terminal.tsx`), so the fastest way to actually try one is to copy it
 * verbatim rather than retype it.
 */
export function CopyCommand({
  text,
  children,
  className,
}: {
  text: string;
  children: React.ReactNode;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      type="button"
      onClick={copy}
      title="Click to copy"
      className={cn(
        "group relative inline-block cursor-pointer rounded p-0 text-left transition-colors hover:bg-surface-hover",
        className,
      )}
    >
      {children}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute -top-7 left-1/2 -translate-x-1/2 rounded-md bg-foreground px-2 py-1 font-sans text-[10px] font-medium whitespace-nowrap text-background transition-opacity",
          copied ? "opacity-100" : "opacity-0",
        )}
      >
        Copied
      </span>
    </button>
  );
}
