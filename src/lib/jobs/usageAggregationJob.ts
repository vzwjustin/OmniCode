/**
 * Usage Aggregation Scheduler
 *
 * Periodically rolls up raw quota_snapshots into hourly_usage_summary and
 * daily_usage_summary tables. Without this scheduler, the aggregation
 * tables introduced in migration 047 would stay empty.
 *
 * - Hourly rollup runs once at startup and then every hour. It covers the
 *   trailing two-hour window so it catches any in-flight rows that landed
 *   right at the hour boundary.
 * - Daily rollup runs once shortly after UTC midnight (00:05 UTC) and
 *   covers the previous calendar day.
 *
 * Both timers are `.unref()`'d so they never prevent the Node process
 * from exiting.
 *
 * @module lib/jobs/usageAggregationJob
 */

import { rollupHourlyQuota, rollupDailyUsage } from "@/lib/usage/aggregateHistory";

let hourlyTimer: NodeJS.Timeout | null = null;
let dailyTimer: NodeJS.Timeout | null = null;

const HOUR_MS = 60 * 60 * 1000;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Format a Date as a SQLite-friendly "YYYY-MM-DD HH:MM:SS" UTC string. */
function toSqliteDateTimeUtc(d: Date): string {
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
  );
}

/** Format a Date as a SQLite-friendly "YYYY-MM-DD" UTC string. */
function toSqliteDateUtc(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

async function runHourlyRollup(): Promise<void> {
  // Roll up the trailing 2 hours so we don't miss rows that arrived just
  // before/after the hour boundary on the previous run.
  const now = new Date();
  const fromDate = new Date(now.getTime() - 2 * HOUR_MS);
  try {
    await rollupHourlyQuota(toSqliteDateTimeUtc(fromDate), toSqliteDateTimeUtc(now));
  } catch (err) {
    console.error("[aggregation] hourly rollup failed", err);
  }
}

async function runDailyRollup(): Promise<void> {
  // Roll up the previous UTC calendar day.
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * HOUR_MS);
  const day = toSqliteDateUtc(yesterday);
  try {
    await rollupDailyUsage(day, day);
  } catch (err) {
    console.error("[aggregation] daily rollup failed", err);
  }
}

function scheduleNextDaily(): void {
  const now = new Date();
  // Next run: 00:05 UTC tomorrow.
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5, 0)
  );
  const delayMs = next.getTime() - now.getTime();
  dailyTimer = setTimeout(async () => {
    await runDailyRollup();
    scheduleNextDaily();
  }, delayMs);
  dailyTimer.unref?.();
}

/**
 * Start the usage aggregation scheduler. Idempotent — calling twice is a no-op.
 */
export function startUsageAggregationJob(): void {
  if (hourlyTimer || dailyTimer) return;

  // Kick off an initial hourly rollup at startup so dashboards are not stale.
  void runHourlyRollup();

  hourlyTimer = setInterval(() => {
    void runHourlyRollup();
  }, HOUR_MS);
  hourlyTimer.unref?.();

  scheduleNextDaily();
}

/**
 * Stop the usage aggregation scheduler. Safe to call multiple times.
 */
export function stopUsageAggregationJob(): void {
  if (hourlyTimer) {
    clearInterval(hourlyTimer);
    hourlyTimer = null;
  }
  if (dailyTimer) {
    clearTimeout(dailyTimer);
    dailyTimer = null;
  }
}
