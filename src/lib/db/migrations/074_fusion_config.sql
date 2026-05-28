-- 057_fusion_config.sql
--
-- Local-fusion orchestrator: persisted configuration for the local-fusion*
-- custom models. Singleton row (id = 'active') updated by the dashboard
-- and consulted by the fusion handler when a chat request comes in with
-- model=local-fusion (or one of its variants) and the caller did not
-- override the relevant field.
--
-- Schema kept minimal: a single JSON blob carries the full config so we
-- can evolve the shape without further migrations.

CREATE TABLE IF NOT EXISTS fusion_config (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);
