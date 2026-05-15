"use client";

import { cn } from "@/shared/utils/cn";

/**
 * Kbd — keyboard-shortcut visual chip.
 *
 * Renders one or more keys as small inline pills, e.g.:
 *
 *   <Kbd>Esc</Kbd>
 *   <Kbd keys={["⌘", "K"]} />
 *   <Kbd keys={["Ctrl", "Enter"]} />
 *
 * Used in hover tooltips, menu items, command palettes, modal footers and any
 * place that needs to teach a keyboard shortcut without cluttering the layout.
 */

type KbdProps = {
  /** Single key as children, OR */
  children?: React.ReactNode;
  /** an array of keys to render as a combo. */
  keys?: ReadonlyArray<string>;
  /** Separator between keys. Defaults to a thin space (no visible glyph). */
  separator?: React.ReactNode;
  size?: "xs" | "sm";
  className?: string;
};

const SIZE_CLASSES: Record<NonNullable<KbdProps["size"]>, string> = {
  xs: "text-[10px] h-4 min-w-[1rem] px-1",
  sm: "text-[11px] h-5 min-w-[1.25rem] px-1.5",
};

function KbdKey({
  value,
  size = "sm",
}: {
  value: React.ReactNode;
  size: NonNullable<KbdProps["size"]>;
}) {
  return (
    <kbd
      className={cn(
        "inline-flex items-center justify-center rounded",
        "font-sans font-medium tabular-nums",
        "bg-black/5 text-text-main dark:bg-white/10",
        "border border-black/10 dark:border-white/10",
        "shadow-[inset_0_-1px_0_rgba(0,0,0,0.05)] dark:shadow-[inset_0_-1px_0_rgba(255,255,255,0.05)]",
        SIZE_CLASSES[size]
      )}
    >
      {value}
    </kbd>
  );
}

export default function Kbd({
  children,
  keys,
  separator = "\u200a",
  size = "sm",
  className,
}: KbdProps) {
  const list = keys ?? (children !== undefined ? [children] : []);
  if (list.length === 0) return null;
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)}>
      {list.map((k, i) => (
        <span key={i} className="inline-flex items-center">
          {i > 0 && <span className="text-text-muted/60">{separator}</span>}
          <KbdKey value={k} size={size} />
        </span>
      ))}
    </span>
  );
}
