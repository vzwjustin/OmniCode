/**
 * Retention cleanup job — runs DB retention cleanups on a recurring interval.
 *
 * Wraps the per-table cleanup functions in `@/lib/db/cleanup` and schedules them
 * to run every 6 hours. The timer is `unref()`'d so it does not block process
 * exit, and a stop function is exposed for graceful shutdown / tests.
 *
 * @module lib/jobs/retentionCleanupJob
 */

import {
  cleanupCallLogs,
  cleanupUsageHistory,
  cleanupCompressionAnalytics,
  cleanupMcpAudit,
  cleanupA2aEvents,
  cleanupMemoryEntries,
} from "@/lib/db/cleanup";

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6h

let timer: NodeJS.Timeout | null = null;

function getIntervalMs(): number {
  const raw = process.env.OMNIROUTE_RETENTION_CLEANUP_INTERVAL_MS;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 60_000 ? parsed : DEFAULT_INTERVAL_MS;
}

export function startRetentionCleanupJob(): NodeJS.Timeout | null {
  if (timer) return timer;

  const run = async (): Promise<void> => {
    try {
      await Promise.all([
        cleanupCallLogs(),
        cleanupUsageHistory(),
        cleanupCompressionAnalytics(),
        cleanupMcpAudit(),
        cleanupA2aEvents(),
        cleanupMemoryEntries(),
      ]);
    } catch (err: unknown) {
      console.error("[RetentionCleanup] Job failed:", err);
    }
  };

  // Kick off an immediate run (fire-and-forget).
  void run();

  timer = setInterval(run, getIntervalMs());
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

export function stopRetentionCleanupJob(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
