"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/shared/utils/cn";
import { copyToClipboard } from "@/shared/utils/clipboard";

/**
 * CopyButton — one-tap clipboard copy with check animation.
 *
 * Drop-in companion for any UI that displays an identifier (task ids, API
 * keys, PR URLs, request ids, model names, endpoint URLs). Uses the existing
 * copyToClipboard helper, which already handles the HTTPS-required Clipboard
 * API plus the execCommand fallback for HTTP deployments.
 *
 * Three modes:
 *   icon       — bare icon button (default, smallest footprint)
 *   labelled   — icon + "Copy" text
 *   inline     — designed to sit next to a code/value chip with `pl-1`
 *
 * Usage:
 *   <CopyButton value={task.id} />
 *   <CopyButton value={pr.url} label="Copy PR URL" />
 *   <CopyButton value={apiKey} mode="labelled" size="sm" />
 */

type CopyButtonMode = "icon" | "labelled" | "inline";
type CopyButtonSize = "xs" | "sm" | "md";

interface CopyButtonProps {
  /** Value to copy. If a function, it's invoked at click time (defer expensive value derivation). */
  value: string | (() => string | Promise<string>);
  /** Aria label / tooltip text shown on hover. Defaults to "Copy". */
  label?: string;
  /** Shown briefly after a successful copy. Defaults to "Copied!". */
  successLabel?: string;
  /** Display mode. Default "icon". */
  mode?: CopyButtonMode;
  size?: CopyButtonSize;
  /** Called after a successful copy (success === true) or failure. */
  onCopy?: (success: boolean, value: string) => void;
  className?: string;
  disabled?: boolean;
}

const SIZE_CLASSES: Record<CopyButtonSize, { btn: string; icon: string; gap: string }> = {
  xs: { btn: "h-5 px-1 text-[10px]", icon: "text-[12px]", gap: "gap-0.5" },
  sm: { btn: "h-6 px-1.5 text-[11px]", icon: "text-[14px]", gap: "gap-1" },
  md: { btn: "h-7 px-2 text-xs", icon: "text-[16px]", gap: "gap-1.5" },
};

export default function CopyButton({
  value,
  label = "Copy",
  successLabel = "Copied",
  mode = "icon",
  size = "sm",
  onCopy,
  className,
  disabled = false,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  const handleCopy = useCallback(async () => {
    if (disabled) return;
    let resolved: string;
    try {
      resolved = typeof value === "function" ? await value() : value;
    } catch {
      resolved = "";
    }
    const ok = resolved ? await copyToClipboard(resolved) : false;
    if (ok) {
      setCopied(true);
      setFailed(false);
    } else {
      setFailed(true);
      setCopied(false);
    }
    onCopy?.(ok, resolved);

    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => {
      setCopied(false);
      setFailed(false);
    }, 1_500);
  }, [disabled, onCopy, value]);

  const sizes = SIZE_CLASSES[size];

  // Live status announced for screen readers when state flips.
  const announce = copied ? successLabel : failed ? "Copy failed" : "";

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? successLabel : label}
      title={copied ? successLabel : failed ? "Copy failed" : label}
      disabled={disabled}
      className={cn(
        "inline-flex items-center justify-center rounded-md font-medium",
        "border border-transparent",
        "text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/5",
        "transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1 focus-visible:ring-offset-bg",
        "disabled:opacity-40 disabled:cursor-not-allowed",
        copied && "text-emerald-600 dark:text-emerald-400",
        failed && "text-red-500",
        sizes.btn,
        sizes.gap,
        mode === "inline" && "pl-1",
        className
      )}
    >
      <span aria-hidden="true" className={cn("material-symbols-outlined", sizes.icon)}>
        {copied ? "check" : failed ? "error" : "content_copy"}
      </span>
      {mode === "labelled" && <span>{copied ? successLabel : label}</span>}
      {announce && (
        <span aria-live="polite" className="sr-only">
          {announce}
        </span>
      )}
    </button>
  );
}
