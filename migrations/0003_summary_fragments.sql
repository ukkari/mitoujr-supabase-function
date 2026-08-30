CREATE TABLE IF NOT EXISTS summary_run_fragments (
  run_id TEXT NOT NULL REFERENCES summary_runs(run_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  channel_id TEXT NOT NULL,
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, channel_id)
);

CREATE INDEX IF NOT EXISTS summary_run_fragments_order_idx
  ON summary_run_fragments (run_id, sequence);
