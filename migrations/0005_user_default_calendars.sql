-- サーバー専用: ユーザーごとのデフォルトカレンダー（予定）とリスト（メールから）の ID を保持
CREATE TABLE IF NOT EXISTS user_default_calendars (
  user_id TEXT NOT NULL UNIQUE,
  task_list_calendar_id INTEGER NOT NULL REFERENCES calendars(id),
  event_calendar_id INTEGER NOT NULL REFERENCES calendars(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_user_default_calendars_user_id ON user_default_calendars(user_id);
