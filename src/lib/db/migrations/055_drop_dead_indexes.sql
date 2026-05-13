-- 055: Drop dead indexes (zero selectivity or 100% NULL columns).
-- idx_uh_provider, idx_uh_service_tier: usage_history columns with single distinct value.
-- idx_cl_combo_target: call_logs(combo_name, combo_execution_key, timestamp) — all NULL combo cols.
DROP INDEX IF EXISTS idx_uh_provider;
DROP INDEX IF EXISTS idx_uh_service_tier;
DROP INDEX IF EXISTS idx_cl_combo_target;
