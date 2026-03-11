-- MCP OAuth 2.0 tables for Authorization Code Flow + PKCE

CREATE TABLE mcp_oauth_clients (
  id TEXT PRIMARY KEY,
  client_secret_hash TEXT,  -- NULL for public clients (PKCE)
  redirect_uris TEXT NOT NULL,  -- JSON array
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE mcp_oauth_codes (
  code TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT,
  code_challenge_method TEXT DEFAULT 'S256',
  scope TEXT DEFAULT 'read-write',
  expires_at TEXT NOT NULL,
  used INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE mcp_oauth_tokens (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  access_token TEXT NOT NULL UNIQUE,
  refresh_token TEXT UNIQUE,
  scope TEXT DEFAULT 'read-write',
  expires_at TEXT NOT NULL,
  revoked INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_mcp_tokens_access ON mcp_oauth_tokens(access_token);
CREATE INDEX idx_mcp_tokens_refresh ON mcp_oauth_tokens(refresh_token);
CREATE INDEX idx_mcp_codes_code ON mcp_oauth_codes(code);
