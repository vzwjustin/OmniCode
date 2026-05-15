/**
 * db/semanticCache.ts — Semantic cache entry CRUD/listing.
 *
 * Backs the `semantic_cache` table used by the cache management dashboard.
 * Routes and handlers MUST go through these helpers — never write raw SQL
 * against `semantic_cache` from outside this module.
 */

import { getDbInstance } from "./core";

export interface SemanticCacheEntry {
  id: string;
  signature: string;
  model: string;
  hit_count: number;
  tokens_saved: number;
  created_at: string;
  expires_at: string;
}

export interface SemanticCacheListOptions {
  page: number;
  limit: number;
  search?: string;
  model?: string;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
}

export interface SemanticCacheListResult {
  entries: SemanticCacheEntry[];
  total: number;
}

const VALID_SORT_COLUMNS = new Set([
  "created_at",
  "expires_at",
  "hit_count",
  "tokens_saved",
  "model",
]);

export function listSemanticCacheEntries(
  options: SemanticCacheListOptions
): SemanticCacheListResult {
  const db = getDbInstance();
  const offset = Math.max(0, (options.page - 1) * options.limit);

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.search) {
    conditions.push("(signature LIKE ? OR model LIKE ?)");
    params.push(`%${options.search}%`, `%${options.search}%`);
  }

  if (options.model) {
    conditions.push("model = ?");
    params.push(options.model);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const orderColumn =
    options.sortBy && VALID_SORT_COLUMNS.has(options.sortBy) ? options.sortBy : "created_at";
  const orderDirection = options.sortOrder === "asc" ? "ASC" : "DESC";

  const countRow = db
    .prepare(`SELECT COUNT(*) as total FROM semantic_cache ${whereClause}`)
    .get(...params) as { total: number } | undefined;

  const entries = db
    .prepare(
      `SELECT id, signature, model, hit_count, tokens_saved, created_at, expires_at
       FROM semantic_cache ${whereClause}
       ORDER BY ${orderColumn} ${orderDirection}
       LIMIT ? OFFSET ?`
    )
    .all(...params, options.limit, offset) as SemanticCacheEntry[];

  return { entries, total: countRow?.total ?? 0 };
}

export function deleteSemanticCacheBySignature(signature: string): number {
  const db = getDbInstance();
  const result = db.prepare("DELETE FROM semantic_cache WHERE signature = ?").run(signature);
  return result.changes;
}

export function deleteSemanticCacheByModel(model: string): number {
  const db = getDbInstance();
  const result = db.prepare("DELETE FROM semantic_cache WHERE model = ?").run(model);
  return result.changes;
}
