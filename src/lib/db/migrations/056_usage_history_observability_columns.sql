-- 056_usage_history_observability_columns.sql
-- Backfills usage_history with observability columns added to migration 001's
-- schema in March 2026 (commit 095c84ac, released v3.3.5). Installations that
-- ran migration 001 before then never received these columns, so usage history
-- inserts (src/lib/usage/usageHistory.ts) fail with "no such column".
-- migrationRunner.ts applies this via ensureColumn() so each ALTER is idempotent.
ALTER TABLE usage_history ADD COLUMN success INTEGER DEFAULT 1;
ALTER TABLE usage_history ADD COLUMN latency_ms INTEGER DEFAULT 0;
ALTER TABLE usage_history ADD COLUMN ttft_ms INTEGER DEFAULT 0;
ALTER TABLE usage_history ADD COLUMN error_code TEXT;
