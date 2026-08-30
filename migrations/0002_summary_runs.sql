CREATE TABLE IF NOT EXISTS summary_runs (
  run_id TEXT PRIMARY KEY,
  target_date_jst TEXT NOT NULL,
  target_label TEXT NOT NULL CHECK (target_label IN ('昨日', '今日')),
  raw_content TEXT,
  summary_text TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS summary_runs_expires_at_idx
  ON summary_runs (expires_at);
