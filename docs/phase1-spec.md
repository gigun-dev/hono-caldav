# Phase 1 仕様: 認証基盤 + マルチユーザー

## ゴール

- Google OAuth でログインし、App Password で CalDAV Basic Auth を提供
- 既存 CalDAV Server をマルチユーザー対応に移行
- Legacy env 認証 (CALDAV_USERNAME/PASSWORD) を完全削除

## 認証方式

| 対象 | 方式 | 実装 |
|------|------|------|
| Web UI | Google OAuth → cookie session | better-auth 標準 |
| CalDAV クライアント | App Password → Basic Auth | カスタム実装 |

### better-auth 設定

- D1 直接接続 (`database: env.DB`)、Drizzle 不要
- Google OAuth のみ (`socialProviders.google`)
- `accessType: "offline"` + `prompt: "consent"` で refresh_token 取得
- Session: 7日有効、24時間ごとリフレッシュ、cookie cache 5分
- `account.encryptOAuthTokens: true` (AES-256-GCM)
- auth インスタンスはリクエストごとに生成 (Workers env binding 制約)

### App Password

- 複数生成可能 (上限なし)
- 32文字 Base62 ランダム文字列
- SHA-256 ハッシュで保存 (平文は生成時に1度だけ表示)
- Soft-delete (`revoked_at` カラム)
- CalDAV username = user.email

## DB スキーマ

### better-auth コアテーブル (CLI で生成)

- `user` — id, name, email (unique), emailVerified, image, createdAt, updatedAt
- `session` — id, userId (FK→user), token (unique), expiresAt, ipAddress, userAgent, createdAt, updatedAt
- `account` — id, userId (FK→user), providerId, accountId, accessToken (暗号化), refreshToken (暗号化), idToken, accessTokenExpiresAt, refreshTokenExpiresAt, scope, password, createdAt, updatedAt
- `verification` — id, identifier, value, expiresAt, createdAt, updatedAt

### app_passwords テーブル

```sql
CREATE TABLE IF NOT EXISTS app_passwords (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Default',
  password_hash TEXT NOT NULL,
  prefix TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_app_passwords_user ON app_passwords(user_id);
```

### 既存テーブルの変更

- `calendars.user_id` — `TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE` に変更
- 既存の `user_id = 'default'` データのマイグレーション考慮

## ファイル構成

```
src/
  auth/
    auth.ts             — better-auth 設定 (createAuth)
    app-password.ts     — App Password 生成・検証・CRUD
  middleware/
    caldav-auth.ts      — CalDAV Basic Auth middleware (App Password)
    auth-guard.ts       — Web session middleware (better-auth)
  pages/
    login.tsx           — Google OAuth ログインページ
    dashboard.tsx       — App Password 管理 (生成・一覧・リボーク)
  caldav/
    handlers.ts         — 認証ロジック削除、middleware に委譲
  index.ts              — ルート統合
migrations/
  0003_auth.sql         — better-auth テーブル + app_passwords
test/
  auth.test.ts          — App Password ユニット + CalDAV インテグレーション
```

## Web UI (Hono JSX + htmx)

### ページ

| パス | 認証 | 内容 |
|------|------|------|
| `/login` | Public | Google OAuth ログインボタン |
| `/dashboard` | Session (authGuard) | App Password 管理 |
| `/api/auth/**` | - | better-auth ハンドラ |
| `/api/app-passwords` | Session | POST: 生成 |
| `/api/app-passwords/:id/revoke` | Session | POST: リボーク |

### htmx 使用箇所

- App Password 生成: `hx-post="/api/app-passwords"` → 一覧を更新
- App Password リボーク: `hx-post="/api/app-passwords/:id/revoke"` → 一覧から削除
- ログアウト: fetch `/api/auth/sign-out` → `/login` にリダイレクト

## CalDAV 認証フロー

```
1. クライアント → PROPFIND /dav/... (Authorization: Basic <email:app_password>)
2. caldav-auth middleware がデコード
3. email でユーザー検索 → active な app_passwords をイテレート
4. SHA-256 ハッシュ照合 → 一致すれば c.set("user", { id, username, displayName })
5. last_used_at を更新 (fire-and-forget)
6. ハンドラは c.get("user") で user_id を取得
```

## テスト方針

- App Password ベースで全テスト実行
- テスト用ユーザーと app_password を DB にシード
- Legacy env 認証のテストは削除
- マルチユーザー分離テスト (ユーザーAのカレンダーにユーザーBがアクセスできない)

## 環境変数

### .dev.vars (ローカル)

```
BETTER_AUTH_URL=http://localhost:8787
BETTER_AUTH_SECRET=<openssl rand -base64 32 で生成>
GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxx
```

### Google Cloud Console 設定

1. OAuth 2.0 Client ID を作成
2. Authorized redirect URIs に追加:
   - `http://localhost:8787/api/auth/callback/google` (ローカル)
   - `https://<your-domain>/api/auth/callback/google` (本番)

### wrangler.jsonc

- `nodejs_compat` compatibility flag (設定済み)

## スコープ外

- mobileconfig / setup ページ → Phase 2
- email/password 認証
- MCP Bearer token → Phase 3
- Rate limiting → Phase 6

## 実装チェックリスト

1. [ ] `migrations/0003_auth.sql` — better-auth テーブル + app_passwords
2. [ ] `src/auth/auth.ts` — better-auth 設定 (D1 + Google OAuth)
3. [ ] `src/auth/app-password.ts` — App Password 生成・検証・CRUD
4. [ ] `src/middleware/auth-guard.ts` — Web session middleware
5. [ ] `src/middleware/caldav-auth.ts` — CalDAV Basic Auth middleware
6. [ ] `src/pages/login.tsx` — Google OAuth ログインページ
7. [ ] `src/pages/dashboard.tsx` — App Password 管理 (htmx)
8. [ ] `src/index.ts` — ルート統合 (/api/auth/**, /login, /dashboard, middleware)
9. [ ] `src/caldav/handlers.ts` — 認証ロジック削除、middleware に委譲
10. [ ] `test/auth.test.ts` — App Password + CalDAV インテグレーション
11. [ ] 既存テストの認証部分を App Password に移行
