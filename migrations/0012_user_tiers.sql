CREATE TABLE user_tiers (
  user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  tier TEXT NOT NULL DEFAULT 'free',  -- 'free' or 'pro'
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  tier_updated_at TEXT DEFAULT (datetime('now'))
);
