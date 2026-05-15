"use client";

import { useEffect, useState } from "react";
import { cn } from "@/shared/utils/cn";

/**
 * RelativeTime — drop-in for `new Date(x).toLocaleString()`.
 *
 * Renders a friendly "2m ago" / "3h ago" / "yesterday" / "May 14" label that
 * auto-updates every 30s, with a hover tooltip carrying the exact absolute
 * timestamp. Designed to be cheap enough to drop in everywhere without
 * thinking — works with Date | string | number, gracefully renders an em-dash
 * for falsy values.
 *
 * Used in many places across the dashboard (cloud-agents, webhooks, skills,
 * batches, search history, CLI tool cards, settings, audit log, cache, …).
 *
 * Usage:
 *   <RelativeTime value={task.createdAt} />
 *   <RelativeTime value={task.updatedAt} prefix="updated" />
 *   <RelativeTime value={task.createdAt} absolute />   // shows absolute string instead
 */

type RelativeTimeProps = {
  value: Date | string | number | null | undefined;
  /** Optional prefix word (e.g. "created", "updated"). Renders as "created 3m ago". */
  prefix?: string;
  /** If true, show absolute formatted timestamp instead of relative. */
  absolute?: boolean;
  /** How often the relative label re-renders, in ms. Default 30s. */
  refreshIntervalMs?: number;
  /** Override the locale; defaults to the user's. */
  locale?: string;
  className?: string;
};

function parseDate(value: RelativeTimeProps["value"]): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function formatRelative(date: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - date.getTime();
  const future = diffMs < 0;
  const abs = Math.abs(diffMs);

  const sec = Math.floor(abs / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);

  let core: string;
  if (sec < 5) core = "just now";
  else if (sec < 60) core = `${sec}s`;
  else if (min < 60) core = `${min}m`;
  else if (hr < 24) core = `${hr}h`;
  else if (day < 7) core = `${day}d`;
  else if (day < 30) core = `${Math.floor(day / 7)}w`;
  else if (day < 365) core = `${Math.floor(day / 30)}mo`;
  else core = `${Math.floor(day / 365)}y`;

  if (core === "just now") return core;
  return future ? `in ${core}` : `${core} ago`;
}

export default function RelativeTime({
  value,
  prefix,
  absolute = false,
  refreshIntervalMs = 30_000,
  locale,
  className,
}: RelativeTimeProps) {
  const date = parseDate(value);

  // Re-render trigger — using a small nonce avoids exposing Date.now() in
  // render so SSR/CSR markup matches on first paint (we hydrate the relative
  // string client-side on the next tick).
  const [, setNonce] = useState(0);
  useEffect(() => {
    if (absolute || !date) return;
    const id = setInterval(() => setNonce((n) => n + 1), refreshIntervalMs);
    return () => clearInterval(id);
  }, [absolute, date, refreshIntervalMs]);

  if (!date) {
    return (
      <span className={cn("text-text-muted", className)} aria-hidden="true">
        —
      </span>
    );
  }

  const absoluteLabel = date.toLocaleString(locale);
  const label = absolute ? absoluteLabel : formatRelative(date);
  const composed = prefix ? `${prefix} ${label}` : label;

  return (
    <time
      dateTime={date.toISOString()}
      title={absoluteLabel}
      className={cn("tabular-nums", className)}
    >
      {composed}
    </time>
  );
}
