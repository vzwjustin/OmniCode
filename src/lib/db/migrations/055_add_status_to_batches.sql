-- 055_add_status_to_batches.sql
-- Ensures the batches table has a status column. Installations that ran
-- migration 028 before status was part of its schema will be missing this
-- column, breaking all batch queries. Existing rows get 'expired' as default.
ALTER TABLE batches ADD COLUMN status TEXT NOT NULL DEFAULT 'expired';
CREATE INDEX IF NOT EXISTS idx_batches_status ON batches(status);
