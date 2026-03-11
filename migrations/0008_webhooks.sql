-- Webhook notification subscriptions
CREATE TABLE IF NOT EXISTS webhooks (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    user_id TEXT NOT NULL,
    url TEXT NOT NULL,
    events TEXT NOT NULL DEFAULT 'create,update,delete',
    secret TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_webhooks_user_id ON webhooks (user_id);
