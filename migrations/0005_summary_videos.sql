CREATE TABLE IF NOT EXISTS summary_videos (
  run_id TEXT PRIMARY KEY,
  plan_json TEXT,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'publishing', 'posted')),
  claim_token TEXT,
  file_id TEXT,
  post_id TEXT,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
