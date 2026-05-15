"use client";
import { useTranslations } from "next-intl";
import { RelativeTime } from "@/shared/components";

/**
 * Shared status badge for CLI tool cards.
 * Shows the effective config/installation status using batch data,
 * so badges are visible even when cards are collapsed.
 * Optionally shows last-configured relative timestamp.
 */

export default function CliStatusBadge({
  effectiveConfigStatus,
  batchStatus,
  lastConfiguredAt = null,
}) {
  const t = useTranslations("cliTools");
  // Determine badge from effectiveConfigStatus or batchStatus
  const status = effectiveConfigStatus || batchStatus?.configStatus || null;

  const badges = {
    configured: {
      dotClass: "bg-green-500",
      badgeClass: "bg-green-500/10 text-green-600 dark:text-green-400",
      text: t("configured"),
    },
    not_configured: {
      dotClass: "bg-yellow-500",
      badgeClass: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400",
      text: t("notConfigured"),
    },
    not_installed: {
      dotClass: "bg-zinc-400 dark:bg-zinc-500",
      badgeClass: "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400",
      text: t("notInstalled"),
    },
    other: {
      dotClass: "bg-blue-500",
      badgeClass: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
      text: t("custom"),
    },
    unknown: {
      dotClass: "bg-zinc-400 dark:bg-zinc-500",
      badgeClass: "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400",
      text: t("unknown"),
    },
  };

  const badge = status ? badges[status] || badges.unknown : null;

  return (
    <>
      {badge && (
        <span
          className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-medium rounded-full ${badge.badgeClass}`}
        >
          <span className={`size-1.5 rounded-full ${badge.dotClass}`} />
          {badge.text}
        </span>
      )}
      {lastConfiguredAt ? (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-text-muted">
          <span className="material-symbols-outlined text-[12px]">schedule</span>
          <RelativeTime value={lastConfiguredAt} />
        </span>
      ) : status && status !== "not_installed" ? (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-text-muted">
          <span className="material-symbols-outlined text-[12px]">schedule</span>
          {t("never")}
        </span>
      ) : null}
    </>
  );
}
