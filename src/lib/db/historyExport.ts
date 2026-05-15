/**
 * db/historyExport.ts — Bulk reads from telemetry/history tables for backup
 * exports.
 *
 * Backs `usage_history`, `domain_cost_history`, and `domain_budgets`. Used
 * exclusively by the `?includeHistory=true` branch of the JSON backup export.
 * Routes and handlers MUST go through these helpers — never write raw SQL
 * against these tables from outside this module.
 */

import { getDbInstance } from "./core";

export function exportUsageHistory(): unknown[] {
  const db = getDbInstance();
  return db.prepare("SELECT * FROM usage_history").all();
}

export function exportDomainCostHistory(): unknown[] {
  const db = getDbInstance();
  return db.prepare("SELECT * FROM domain_cost_history").all();
}

export function exportDomainBudgets(): unknown[] {
  const db = getDbInstance();
  return db.prepare("SELECT * FROM domain_budgets").all();
}
