CREATE TABLE gmail_sync_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  last_history_id TEXT,
  last_poll_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_gmail_sync_user ON gmail_sync_state(user_id);
