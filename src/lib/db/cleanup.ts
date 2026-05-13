/**
 * Database cleanup functions for removing old data based on retention policies.
 *
 * @module lib/db/cleanup
 */

import { getDbInstance } from "./core";
import { getUserDatabaseSettings } from "./databaseSettings";

interface CleanupResult {
  deleted: number;
  errors: number;
}

function getRetentionSettings() {
  return getUserDatabaseSettings().retention;
}

/**
 * Clean up old quota_snapshots based on retention settings.
 */
export async function cleanupQuotaSnapshots(): Promise<CleanupResult> {
  const db = getDbInstance();
  const retention = getRetentionSettings();

  const retentionDays = retention.quotaSnapshots;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  const cutoffISO = cutoffDate.toISOString();

  const result: CleanupResult = { deleted: 0, errors: 0 };

  try {
    const stmt = db.prepare("DELETE FROM quota_snapshots WHERE created_at < ?");
    const runResult = stmt.run(cutoffISO);
    result.deleted = runResult.changes;

    console.log(
      `[Cleanup] Deleted ${result.deleted} quota_snapshots older than ${retentionDays} days`
    );
  } catch (err: unknown) {
    console.error("[Cleanup] Error cleaning quota_snapshots:", err);
    result.errors++;
  }

  return result;
}

/**
 * Clean up old call_logs based on retention settings.
 */
export async function cleanupCallLogs(): Promise<CleanupResult> {
  const db = getDbInstance();
  const retention = getRetentionSettings();

  const retentionDays = retention.callLogs;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  const cutoffISO = cutoffDate.toISOString();

  const result: CleanupResult = { deleted: 0, errors: 0 };

  try {
    const stmt = db.prepare("DELETE FROM call_logs WHERE created_at < ?");
    const runResult = stmt.run(cutoffISO);
    result.deleted = runResult.changes;

    console.log(`[Cleanup] Deleted ${result.deleted} call_logs older than ${retentionDays} days`);
  } catch (err: unknown) {
    console.error("[Cleanup] Error cleaning call_logs:", err);
    result.errors++;
  }

  return result;
}

/**
 * Clean up old usage_history based on retention settings.
 */
export async function cleanupUsageHistory(): Promise<CleanupResult> {
  const db = getDbInstance();
  const retention = getRetentionSettings();

  const retentionDays = retention.usageHistory;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  const cutoffISO = cutoffDate.toISOString();

  const result: CleanupResult = { deleted: 0, errors: 0 };

  try {
    const stmt = db.prepare("DELETE FROM usage_history WHERE timestamp < ?");
    const runResult = stmt.run(cutoffISO);
    result.deleted = runResult.changes;

    console.log(
      `[Cleanup] Deleted ${result.deleted} usage_history older than ${retentionDays} days`
    );
  } catch (err: unknown) {
    console.error("[Cleanup] Error cleaning usage_history:", err);
    result.errors++;
  }

  return result;
}

/**
 * Clean up old compression_analytics based on retention settings.
 */
export async function cleanupCompressionAnalytics(): Promise<CleanupResult> {
  const db = getDbInstance();
  const retention = getRetentionSettings();

  const retentionDays = retention.compressionAnalytics;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  const cutoffISO = cutoffDate.toISOString();

  const result: CleanupResult = { deleted: 0, errors: 0 };

  try {
    // NOTE: compression_analytics uses `timestamp` (per migration 038), not `created_at`.
    // TODO(future): add a fallback index migration that adds `created_at` for consistency.
    const stmt = db.prepare("DELETE FROM compression_analytics WHERE timestamp < ?");
    const runResult = stmt.run(cutoffISO);
    result.deleted = runResult.changes;

    console.log(
      `[Cleanup] Deleted ${result.deleted} compression_analytics older than ${retentionDays} days`
    );
  } catch (err: unknown) {
    console.error("[Cleanup] Error cleaning compression_analytics:", err);
    result.errors++;
  }

  return result;
}

/**
 * Clean up old mcp_tool_audit based on retention settings.
 */
export async function cleanupMcpAudit(): Promise<CleanupResult> {
  const db = getDbInstance();
  const retention = getRetentionSettings();

  const retentionDays = retention.mcpAudit;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  const cutoffISO = cutoffDate.toISOString();

  const result: CleanupResult = { deleted: 0, errors: 0 };

  try {
    // Real table name is mcp_tool_audit with column `created_at` (per migration 002).
    const stmt = db.prepare("DELETE FROM mcp_tool_audit WHERE created_at < ?");
    const runResult = stmt.run(cutoffISO);
    result.deleted = runResult.changes;

    console.log(
      `[Cleanup] Deleted ${result.deleted} mcp_tool_audit older than ${retentionDays} days`
    );
  } catch (err: unknown) {
    console.error("[Cleanup] Error cleaning mcp_tool_audit:", err);
    result.errors++;
  }

  return result;
}

/**
 * Clean up old a2a_task_events based on retention settings.
 */
export async function cleanupA2aEvents(): Promise<CleanupResult> {
  const db = getDbInstance();
  const retention = getRetentionSettings();

  const retentionDays = retention.a2aEvents;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  const cutoffISO = cutoffDate.toISOString();

  const result: CleanupResult = { deleted: 0, errors: 0 };

  try {
    // Real table name is a2a_task_events with column `created_at` (per migration 002).
    const stmt = db.prepare("DELETE FROM a2a_task_events WHERE created_at < ?");
    const runResult = stmt.run(cutoffISO);
    result.deleted = runResult.changes;

    console.log(
      `[Cleanup] Deleted ${result.deleted} a2a_task_events older than ${retentionDays} days`
    );
  } catch (err: unknown) {
    console.error("[Cleanup] Error cleaning a2a_task_events:", err);
    result.errors++;
  }

  return result;
}

/**
 * Clean up old memories based on retention settings.
 */
export async function cleanupMemoryEntries(): Promise<CleanupResult> {
  const db = getDbInstance();
  const retention = getRetentionSettings();

  const retentionDays = retention.memoryEntries;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  const cutoffISO = cutoffDate.toISOString();

  const result: CleanupResult = { deleted: 0, errors: 0 };

  try {
    // Real table name is `memories` with column `created_at` (per migration 015).
    const stmt = db.prepare("DELETE FROM memories WHERE created_at < ?");
    const runResult = stmt.run(cutoffISO);
    result.deleted = runResult.changes;

    console.log(`[Cleanup] Deleted ${result.deleted} memories older than ${retentionDays} days`);
  } catch (err: unknown) {
    console.error("[Cleanup] Error cleaning memories:", err);
    result.errors++;
  }

  return result;
}

/**
 * Run all cleanup functions if auto-cleanup is enabled.
 */
export async function runAutoCleanup(): Promise<{
  totalDeleted: number;
  totalErrors: number;
  results: Record<string, CleanupResult>;
}> {
  const retention = getRetentionSettings();
  const autoCleanupEnabled = retention.autoCleanupEnabled;

  if (!autoCleanupEnabled) {
    console.log("[Cleanup] Auto-cleanup is disabled");
    return { totalDeleted: 0, totalErrors: 0, results: {} };
  }

  console.log("[Cleanup] Starting auto-cleanup...");

  const results: Record<string, CleanupResult> = {
    quotaSnapshots: await cleanupQuotaSnapshots(),
    callLogs: await cleanupCallLogs(),
    usageHistory: await cleanupUsageHistory(),
    compressionAnalytics: await cleanupCompressionAnalytics(),
    mcpAudit: await cleanupMcpAudit(),
    a2aEvents: await cleanupA2aEvents(),
    memoryEntries: await cleanupMemoryEntries(),
  };

  const totalDeleted = Object.values(results).reduce((sum, r) => sum + r.deleted, 0);
  const totalErrors = Object.values(results).reduce((sum, r) => sum + r.errors, 0);

  console.log(`[Cleanup] Auto-cleanup complete: ${totalDeleted} deleted, ${totalErrors} errors`);

  return { totalDeleted, totalErrors, results };
}

/**
 * Purge ALL quota_snapshots immediately (no retention check).
 */
export async function purgeQuotaSnapshots(): Promise<CleanupResult> {
  const db = getDbInstance();
  const result: CleanupResult = { deleted: 0, errors: 0 };

  try {
    const stmt = db.prepare("DELETE FROM quota_snapshots");
    const runResult = stmt.run();
    result.deleted = runResult.changes;

    console.log(`[Cleanup] Purged ${result.deleted} quota_snapshots`);
  } catch (err: unknown) {
    console.error("[Cleanup] Error purging quota_snapshots:", err);
    result.errors++;
  }

  return result;
}

/**
 * Purge ALL call_logs immediately (no retention check).
 */
export async function purgeCallLogs(): Promise<CleanupResult> {
  const db = getDbInstance();
  const result: CleanupResult = { deleted: 0, errors: 0 };

  try {
    const stmt = db.prepare("DELETE FROM call_logs");
    const runResult = stmt.run();
    result.deleted = runResult.changes;

    console.log(`[Cleanup] Purged ${result.deleted} call_logs`);
  } catch (err: unknown) {
    console.error("[Cleanup] Error purging call_logs:", err);
    result.errors++;
  }

  return result;
}

/**
 * Purge ALL request_detail_logs immediately (no retention check).
 */
export async function purgeDetailedLogs(): Promise<CleanupResult> {
  const db = getDbInstance();
  const result: CleanupResult = { deleted: 0, errors: 0 };

  try {
    const stmt = db.prepare("DELETE FROM request_detail_logs");
    const runResult = stmt.run();
    result.deleted = runResult.changes;

    console.log(`[Cleanup] Purged ${result.deleted} request_detail_logs`);
  } catch (err: unknown) {
    console.error("[Cleanup] Error purging request_detail_logs:", err);
    result.errors++;
  }

  return result;
}
