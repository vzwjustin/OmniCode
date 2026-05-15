/**
 * db/proxyLogs.ts — Proxy log read access.
 *
 * Backs the `proxy_logs` table. Routes and handlers MUST go through these
 * helpers — never write raw SQL against `proxy_logs` from outside this module.
 */

import { getDbInstance } from "./core";

export function getProxyLogsSince(since: string): unknown[] {
  const db = getDbInstance();
  return db
    .prepare("SELECT * FROM proxy_logs WHERE timestamp >= @since ORDER BY timestamp DESC")
    .all({ since });
}
