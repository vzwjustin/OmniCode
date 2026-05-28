-- 056_api_keys_hash_only.sql
--
-- Tranche A — Task A6.a (plans/2026-05-14-omniroute-bug-fixes-v1.md):
-- Retire the plaintext `api_keys.key` column for any row whose `key_hash`
-- is already populated. The column is NOT dropped in this migration —
-- a future migration will drop it once one release of backwards-compat
-- (gated by OMNIROUTE_LEGACY_PLAINTEXT_KEYS=1) has shipped.
--
-- This migration is intentionally dispatched through a special-case
-- handler in `migrationRunner.ts` because the row-level SHA-256 backfill
-- cannot be expressed in SQLite SQL (no native sha256()). The handler:
--   1. Hashes every row whose `key_hash IS NULL` from the existing `key`
--      value (in TS, using node:crypto.createHash).
--   2. Sets `key = NULL` on every row whose `key_hash IS NOT NULL`.
--
-- The statement below is kept as the canonical SQL form of step 2 so
-- this file is still a valid SQLite migration that exec()s cleanly on a
-- fresh database where every row already has key_hash populated.

UPDATE api_keys
SET key = NULL
WHERE key_hash IS NOT NULL
  AND key IS NOT NULL;
