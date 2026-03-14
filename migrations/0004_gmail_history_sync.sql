-- Gmail History API のポーリング用: ユーザーごとの最後の historyId を保存
CREATE TABLE IF NOT EXISTS gmail_history_sync (
  user_id TEXT PRIMARY KEY,
  history_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
