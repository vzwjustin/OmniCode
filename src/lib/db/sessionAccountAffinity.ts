/**
 * Session → provider connection affinity.
 *
 * Backed by the `session_account_affinity` table (migration 050):
 *   session_key TEXT, provider TEXT, connection_id TEXT,
 *   created_at INTEGER, last_seen_at INTEGER, PK(session_key, provider).
 *
 * @module lib/db/sessionAccountAffinity
 */

import { getDbInstance } from "./core";

export interface SessionAccountAffinityRow {
  sessionKey: string;
  provider: string;
  connectionId: string;
  createdAt: number;
  lastSeenAt: number;
}

interface RawRow {
  session_key?: unknown;
  provider?: unknown;
  connection_id?: unknown;
  created_at?: unknown;
  last_seen_at?: unknown;
}

function rowToAffinity(row: RawRow | undefined): SessionAccountAffinityRow | null {
  if (!row) return null;
  const sessionKey = typeof row.session_key === "string" ? row.session_key : null;
  const provider = typeof row.provider === "string" ? row.provider : null;
  const connectionId = typeof row.connection_id === "string" ? row.connection_id : null;
  const createdAt = typeof row.created_at === "number" ? row.created_at : Number(row.created_at);
  const lastSeenAt =
    typeof row.last_seen_at === "number" ? row.last_seen_at : Number(row.last_seen_at);
  if (!sessionKey || !provider || !connectionId) return null;
  if (!Number.isFinite(createdAt) || !Number.isFinite(lastSeenAt)) return null;
  return { sessionKey, provider, connectionId, createdAt, lastSeenAt };
}

export function getSessionAccountAffinity(
  sessionKey: string,
  provider: string
): SessionAccountAffinityRow | null {
  try {
    const db = getDbInstance();
    const row = db
      .prepare(
        "SELECT session_key, provider, connection_id, created_at, last_seen_at " +
          "FROM session_account_affinity WHERE session_key = ? AND provider = ?"
      )
      .get(sessionKey, provider) as RawRow | undefined;
    return rowToAffinity(row);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[SessionAffinity] getSessionAccountAffinity failed: ${msg}`);
    return null;
  }
}

export function upsertSessionAccountAffinity(
  sessionKey: string,
  provider: string,
  connectionId: string,
  now: number = Date.now()
): void {
  try {
    const db = getDbInstance();
    db.prepare(
      "INSERT INTO session_account_affinity (session_key, provider, connection_id, created_at, last_seen_at) " +
        "VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(session_key, provider) DO UPDATE SET " +
        "connection_id = excluded.connection_id, " +
        "last_seen_at = excluded.last_seen_at"
    ).run(sessionKey, provider, connectionId, now, now);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[SessionAffinity] upsertSessionAccountAffinity failed: ${msg}`);
  }
}

export function touchSessionAccountAffinity(
  sessionKey: string,
  provider: string,
  now: number = Date.now()
): void {
  try {
    const db = getDbInstance();
    db.prepare(
      "UPDATE session_account_affinity SET last_seen_at = ? WHERE session_key = ? AND provider = ?"
    ).run(now, sessionKey, provider);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[SessionAffinity] touchSessionAccountAffinity failed: ${msg}`);
  }
}

export function deleteSessionAccountAffinity(sessionKey: string, provider: string): void {
  try {
    const db = getDbInstance();
    db.prepare("DELETE FROM session_account_affinity WHERE session_key = ? AND provider = ?").run(
      sessionKey,
      provider
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[SessionAffinity] deleteSessionAccountAffinity failed: ${msg}`);
  }
}

export function cleanupStaleSessionAccountAffinities(
  ttlMs: number = 30 * 60 * 1000,
  now: number = Date.now()
): number {
  try {
    const db = getDbInstance();
    const cutoff = now - ttlMs;
    const result = db
      .prepare("DELETE FROM session_account_affinity WHERE last_seen_at < ?")
      .run(cutoff);
    return result.changes ?? 0;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[SessionAffinity] cleanupStaleSessionAccountAffinities failed: ${msg}`);
    return 0;
  }
}

let _cleanupTimer: NodeJS.Timeout | null = null;

export function startSessionAccountAffinityCleanup(intervalMs: number = 15 * 60 * 1000): void {
  if (_cleanupTimer) return;
  _cleanupTimer = setInterval(() => {
    cleanupStaleSessionAccountAffinities();
  }, intervalMs);
  if (typeof _cleanupTimer.unref === "function") _cleanupTimer.unref();
}

export function stopSessionAccountAffinityCleanupForTests(): void {
  if (_cleanupTimer) {
    clearInterval(_cleanupTimer);
    _cleanupTimer = null;
  }
}
