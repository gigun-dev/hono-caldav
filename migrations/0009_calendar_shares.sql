-- Calendar sharing support
CREATE TABLE IF NOT EXISTS calendar_shares (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL,
    shared_with TEXT NOT NULL,
    permission TEXT NOT NULL DEFAULT 'read',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_shares_unique ON calendar_shares(calendar_id, shared_with);
CREATE INDEX IF NOT EXISTS idx_calendar_shares_shared ON calendar_shares(shared_with);
