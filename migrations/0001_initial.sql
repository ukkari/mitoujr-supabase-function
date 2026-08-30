PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS reminders (
  post_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  due_date TEXT NOT NULL CHECK (
    length(due_date) = 10 AND
    substr(due_date, 5, 1) = '-' AND
    substr(due_date, 8, 1) = '-'
  ),
  content TEXT NOT NULL DEFAULT '',
  target_usernames_json TEXT,
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  created_at TEXT,
  updated_at TEXT NOT NULL,
  legacy_row_json TEXT
);

CREATE INDEX IF NOT EXISTS reminders_incomplete_due_date_idx
  ON reminders (completed, due_date);

CREATE TABLE IF NOT EXISTS reminder_deliveries (
  post_id TEXT NOT NULL REFERENCES reminders(post_id) ON DELETE CASCADE,
  delivery_date_jst TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 1,
  claim_token TEXT,
  reply_post_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  PRIMARY KEY (post_id, delivery_date_jst)
);

CREATE INDEX IF NOT EXISTS reminder_deliveries_status_idx
  ON reminder_deliveries (status, updated_at);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
