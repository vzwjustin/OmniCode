/**
 * db/databaseSnapshot.ts — Cross-table introspection helpers used by backup
 * export/import flows.
 *
 * Backs `sqlite_master` listing plus per-table COUNT(*) and pre-redacted
 * SELECT projections for `provider_connections`, `provider_nodes`, `combos`,
 * and `api_keys`. Routes and handlers MUST go through these helpers — never
 * write raw SQL against these tables from outside this module.
 */

import type Database from "better-sqlite3";
import { getDbInstance } from "./core";

export function listTables(db?: InstanceType<typeof Database>): string[] {
  const handle = db ?? getDbInstance();
  return (
    handle.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
}

export interface DatabaseTableCounts {
  providerConnections: number;
  providerNodes: number;
  combos: number;
  apiKeys: number;
}

export function getDatabaseTableCounts(): DatabaseTableCounts {
  const db = getDbInstance();
  const safeCount = (table: string): number => {
    try {
      const row = db.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get() as
        | { cnt?: number }
        | undefined;
      return row?.cnt ?? 0;
    } catch {
      return 0;
    }
  };

  return {
    providerConnections: safeCount("provider_connections"),
    providerNodes: safeCount("provider_nodes"),
    combos: safeCount("combos"),
    apiKeys: safeCount("api_keys"),
  };
}

export interface KeyValuePair {
  key: string;
  value: string;
}

export function exportKeyValueSettings(): KeyValuePair[] {
  try {
    return getDbInstance().prepare("SELECT key, value FROM key_value").all() as KeyValuePair[];
  } catch {
    return [];
  }
}

export function exportComboRows(): unknown[] {
  try {
    return getDbInstance().prepare("SELECT * FROM combos").all();
  } catch {
    return [];
  }
}

export function exportProviderConnectionMetadata(): unknown[] {
  try {
    return getDbInstance()
      .prepare(
        "SELECT id, provider, name, auth_type, is_active, email, created_at FROM provider_connections"
      )
      .all();
  } catch {
    return [];
  }
}

export function exportApiKeyMetadata(): unknown[] {
  try {
    return getDbInstance()
      .prepare("SELECT id, name, substr(key, 1, 8) as prefix, machine_id, created_at FROM api_keys")
      .all();
  } catch {
    return [];
  }
}
