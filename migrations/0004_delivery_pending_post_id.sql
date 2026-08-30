ALTER TABLE reminder_deliveries ADD COLUMN pending_post_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS reminder_deliveries_pending_post_id_idx
  ON reminder_deliveries (pending_post_id)
  WHERE pending_post_id IS NOT NULL;
