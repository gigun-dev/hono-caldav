# hono-caldav SaaS Specification

## Vision

CalDAV ベースの AI タスク管理 SaaS。
任意の CalDAV クライアント (iOS リマインダー/カレンダー) や MCP から接続でき、
Google 連携で Gmail からのタスク抽出や Google Calendar の free/busy 管理を AI で自然言語 CRUD する。

## Architecture

```
Clients
  iOS Calendar/Reminders (CalDAV Basic Auth + App Password)
  MCP App / AI Agent (MCP Streamable HTTP + Bearer token)
  External CalDAV Client (tsdav 等で CalDAV プロトコル経由)
  Web Browser (Hono JSX + htmx)

Cloudflare Workers (Hono)
  /dav/*        CalDAV Server (App Password Basic Auth)
  /api/auth/*   better-auth (Google OAuth)
  /api/*        Integration API (session auth)
  /mcp          MCP Server (Bearer token auth)
  /             Web UI (Hono JSX + htmx)

Data Layer
  storage.ts    共通データ層 (WHERE user_id = ? で RLS 相当)
  D1            Single database

Background
  Scheduled Workers   Gmail polling cron
  Email Routing       iTIP/iMIP 受信 (scheduling@domain)
```

## Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Runtime | Cloudflare Workers | D1 binding, Email Routing, Scheduled Workers が同一エコシステム |
| Framework | Hono | 既存の CalDAV Server がベース |
| DB | D1 (SQLite) | Paid $5/mo で 250億 reads/月。10GB/DB 上限あり |
| Auth | better-auth | Google OAuth + session 管理 + D1 adapter |
| CalDAV Auth | App Password + Basic Auth | ユーザーがダッシュボードで発行・リボーク可能 |
| Frontend | Hono JSX + htmx | Workers 完結、バンドル不要、軽量 |
| CalDAV Client (外部連携) | tsdav | 外部から CalDAV プロトコル経由でアクセスする場合の抽象化レイヤー |
| MCP SDK | @modelcontextprotocol/server | Hono + Web Standard API で MCP Server を構築 |
| AI | Workers AI / Gemini Flash | メールからのタスク抽出、自然言語 CRUD |
| OAuth Provider | Google のみ | Gmail API + Google Calendar API でフル統合 |

## Authentication Design

### 3系統の認証

1. **Web / API**: better-auth (Google OAuth) -> session cookie
2. **CalDAV**: App Password + Basic Auth
3. **MCP**: Bearer token (将来的に workers-oauth-provider で MCP 標準 OAuth に移行)

### App Password

- ダッシュボードで生成 (ランダム文字列)
- ユーザーが任意にリボーク・再生成可能
- CalDAV クライアントの Basic Auth パスワードとして使用
- スコープ: CalDAV 全体へのアクセス (カレンダー単位制限なし)

### iOS セットアップ

ダッシュボードから mobileconfig をダウンロード。
CalDAV アカウント設定 (サーバー URL + username + App Password) が自動適用される。

## DB Security (Supabase RLS 代替)

D1 は Workers binding からのみアクセス可能 (外部直接アクセス不可)。

- CalDAV Client -> Workers -> 認証 MW -> storage.ts (WHERE user_id = ?)
- Cron / Integration -> Workers -> storage.ts (内部呼び出し、user_id 指定)
- storage.ts の全クエリに user_id フィルタを徹底 (コードレビュー + テストで担保)

## DB Schema (設計案)

### 命名規則

- better-auth コアテーブル: **単数形** (`user`, `session`, `account`, `verification`) — better-auth デフォルト
- better-auth カラム: **camelCase** (`userId`, `createdAt` 等) — better-auth デフォルト
- アプリテーブル: **snake_case** (`app_passwords`, `calendars` 等) — 既存コードとの一貫性
- better-auth CLI で SQL 生成 → wrangler d1 migrations で適用

### better-auth managed tables (4テーブル)

`bunx @better-auth/cli@latest generate` で生成。主要カラム:

- **`user`**: id, name, email (unique), emailVerified, image, createdAt, updatedAt
- **`session`**: id, userId (FK→user), token (unique), expiresAt, ipAddress, userAgent, createdAt, updatedAt
- **`account`**: id, userId (FK→user), providerId, accountId, accessToken, refreshToken, idToken, accessTokenExpiresAt, refreshTokenExpiresAt, scope, password, createdAt, updatedAt
- **`verification`**: id, identifier, value, expiresAt, createdAt, updatedAt

※ `account.encryptOAuthTokens: true` で accessToken/refreshToken は AES-256-GCM 暗号化保存

### App tables

```sql
-- CalDAV App Password
CREATE TABLE app_passwords (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Default',          -- 識別名
  password_hash TEXT NOT NULL,                   -- SHA-256 hash
  prefix TEXT NOT NULL,                          -- 先頭 8 文字 (表示用)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at TEXT                                -- NULL = active
);

CREATE INDEX idx_app_passwords_user ON app_passwords(user_id);

-- 既存テーブル (user_id を TEXT に変更して user.id と紐付け)
CREATE TABLE calendars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  component_type TEXT NOT NULL DEFAULT 'VTODO',
  ctag TEXT NOT NULL DEFAULT (CAST(strftime('%s','now') AS TEXT)),
  synctoken INTEGER NOT NULL DEFAULT 0,
  color TEXT,
  calendar_order INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- calendar_objects, calendarchanges は変更なし
```

## iTIP Architecture (SaaS as Organizer)

SaaS がすべての VEVENT/VTODO の Organizer になり、ユーザーは Attendee。
カレンダーアプリの参加/辞退 UI をタダ乗りできる。

### Flow: メール -> タスク

1. Gmail OAuth でメール取得 (Scheduled Worker cron)
2. chrono-node で日時表現検出 (Workers 上)
3. Gemini Flash で抽出・分類 (VEVENT or VTODO)
4. CalDAV Server に PUT、PARTSTAT=NEEDS-ACTION でユーザーを Attendee に設定
5. ユーザーのカレンダー/リマインダーに表示

### REPLY 処理

ユーザーがカレンダーアプリで参加/辞退 → iMIP (メール) で REPLY が届く。
scheduling@domain を Email Worker で受信 → postal-mime でパース → PARTSTAT 更新。
DECLINE はフィードバックとして蓄積 (タスク抽出精度改善用)。

### COUNTER 自動 ACCEPT

ユーザーが時間変更 -> COUNTER -> 無条件で更新 -> 新しい REQUEST 返却。
Organizer が機械なので「ユーザーは常に正しい」ポリシー。

### iMIP 受信

scheduling@domain を Email Worker で受信。
外部からの iTIP REPLY/COUNTER をメール経由で処理。

## Integration

### データアクセス方式

| 接続元 | 方式 | 経路 |
|--------|------|------|
| iOS リマインダー等 | CalDAV プロトコル (XML) | → handlers.ts → storage.ts → D1 |
| MCP App (Claude Desktop 等) | MCP Streamable HTTP (JSON-RPC) | → mcp-server.ts → storage.ts → D1 |
| 外部 CalDAV クライアント | tsdav 等で CalDAV プロトコル経由 | → handlers.ts → storage.ts → D1 |
| 同一 Workers 内 (Cron, Email) | storage.ts 直接呼び出し | → storage.ts → D1 |

MCP Server は storage.ts を直接呼ぶ設計 (CalDAV XML のオーバーヘッドを回避)。
tsdav は外部から CalDAV プロトコル経由でアクセスする場合の抽象化ライブラリ。

## D1 Limits (調査済み)

| | Free | Paid ($5/mo) |
|---|---|---|
| Rows read | 500万/日 | 250億/月 |
| Rows written | 10万/日 | 5000万/月 |
| Storage | 5 GB / 500 MB per DB | 5 GB 込み, 10 GB per DB (上限固定) |
| Egress | 無料 | 無料 |
| Concurrency | シングルスレッド / ~1000 QPS (1ms query) |
| Read Replication | 追加料金なし |

10GB 上限が気になるフェーズ (数千ユーザー?) で per-user DB 分割を検討。

## Implementation Phases

### Phase 1: 認証基盤 + マルチユーザー (NOW)

1. better-auth セットアップ (D1 adapter)
2. Google OAuth プロバイダ設定 (login scope のみ)
3. DB マイグレーション (users, sessions, accounts, app_passwords)
4. App Password 生成・リボーク API
5. CalDAV ハンドラの認証を App Password に切り替え
6. 最小限の Web UI (ログイン, ダッシュボード, App Password 管理)

### Phase 2: CalDAV Server 成熟

1. マルチユーザーでのテスト拡充
2. mobileconfig 生成エンドポイント
3. CalDAV プロトコルのエッジケース対応

### Phase 3: AI Integration

1. MCP Server 構築 (@modelcontextprotocol/server + Hono, Bearer token 認証)
2. MCP tools: list_calendars, list/create/update/complete/delete_task, search_tasks
3. Google OAuth スコープ拡張 (Gmail, Google Calendar)
4. Gmail polling (Scheduled Worker) + Workers AI でタスク抽出
5. 自然言語 CRUD API
6. 将来: workers-oauth-provider で MCP 標準 OAuth

### Phase 4: iTIP / iMIP

1. SaaS as Organizer モデル実装
2. iMIP REQUEST 送信 (Resend)
3. Email Routing Worker で iMIP 受信 (postal-mime)
4. REPLY 処理 (PARTSTAT 更新)
5. COUNTER 自動 ACCEPT (「ユーザーは常に正しい」ポリシー)
6. フィードバックループ (DECLINE -> 精度改善)
