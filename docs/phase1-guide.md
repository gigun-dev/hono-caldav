# Phase 1: 認証基盤 + マルチユーザー ガイド

## 1. better-auth + Hono + D1 統合

### D1 アダプター

better-auth v1.5.4 は D1Database を直接サポート。内部的に Kysely アダプターが使われる。

```ts
// src/auth/auth.ts
import { betterAuth } from "better-auth";

// Workers では env がリクエストごとに渡されるため、
// auth インスタンスはリクエストごとに生成する
export function createAuth(env: CloudflareBindings) {
  return betterAuth({
    database: env.DB, // D1Database を直接渡す
    baseURL: env.BETTER_AUTH_URL, // e.g. "https://caldav.example.com"
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        accessType: "offline",   // refresh_token 取得
        prompt: "consent",       // 初回 consent 画面表示
        // Phase 1 ではログインのみ。Phase 3 で Gmail/GCal スコープ追加
        // include_granted_scopes: "true" が組み込み済み (incremental auth)
      },
    },
    account: {
      encryptOAuthTokens: true, // AES-256-GCM で暗号化保存
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,  // 7 日
      updateAge: 60 * 60 * 24,       // 24 時間ごとにリフレッシュ
      cookieCache: {
        enabled: true,
        maxAge: 60 * 5, // 5 分キャッシュ (D1 クエリ削減)
        strategy: "compact",
      },
    },
  });
}
```

### Hono との統合

```ts
// src/index.ts
import { Hono } from "hono";
import { createAuth } from "./auth/auth.js";

const app = new Hono<{ Bindings: CloudflareBindings }>();

// better-auth ルートハンドラ
app.on(["POST", "GET"], "/api/auth/**", (c) => {
  const auth = createAuth(c.env);
  return auth.handler(c.req.raw);
});
```

### Workers 環境の注意点

- **auth インスタンスはリクエストごとに生成** (env バインディングの制約)
- `process.env` 不可 → `secret`, `baseURL` を明示的に設定
- `nodejs_compat` フラグが必要 (wrangler.jsonc で設定済み)
- Rate limiting の storage は `"database"` にする (Workers は "memory" だとリクエスト間で保持されない)

---

## 2. DB スキーマ

### better-auth コアテーブル (4 テーブル)

**`user` テーブル**

| カラム | 型 | 備考 |
|--------|------|------|
| id | TEXT PK | |
| name | TEXT | 必須 |
| email | TEXT UNIQUE | lowercased |
| emailVerified | BOOLEAN | default: false |
| image | TEXT | nullable |
| createdAt | DATE | |
| updatedAt | DATE | |

**`session` テーブル**

| カラム | 型 | 備考 |
|--------|------|------|
| id | TEXT PK | |
| userId | TEXT FK | → user |
| token | TEXT UNIQUE | セッショントークン |
| expiresAt | DATE | |
| ipAddress | TEXT | nullable |
| userAgent | TEXT | nullable |
| createdAt | DATE | |
| updatedAt | DATE | |

**`account` テーブル**

| カラム | 型 | 備考 |
|--------|------|------|
| id | TEXT PK | |
| userId | TEXT FK | → user |
| providerId | TEXT | "google" 等 |
| accountId | TEXT | プロバイダ側 ID |
| accessToken | TEXT | nullable, 暗号化 |
| refreshToken | TEXT | nullable, 暗号化 |
| idToken | TEXT | nullable |
| accessTokenExpiresAt | DATE | nullable |
| refreshTokenExpiresAt | DATE | nullable |
| scope | TEXT | 付与スコープ |
| password | TEXT | credential 認証用 |
| createdAt | DATE | |
| updatedAt | DATE | |

**`verification` テーブル**

| カラム | 型 | 備考 |
|--------|------|------|
| id | TEXT PK | |
| identifier | TEXT | 用途識別子 |
| value | TEXT | トークン値 |
| expiresAt | DATE | |
| createdAt | DATE | |
| updatedAt | DATE | |

### マイグレーション方法

**推奨: CLI で SQL 生成 → wrangler で適用**

```bash
# SQL 生成
bunx @better-auth/cli@latest generate --output ./migrations/0003_auth.sql

# ローカル適用
bun wrangler d1 migrations apply hono-caldav --local

# リモート適用
bun wrangler d1 migrations apply hono-caldav --remote
```

既存の `migrations/` ディレクトリ管理と一貫性を保てる。

### カスタムフィールド追加

```ts
betterAuth({
  user: {
    additionalFields: {
      caldavEnabled: {
        type: "boolean",
        required: false,
        defaultValue: false,
      },
    },
  },
});
```

---

## 3. App Password 実装

### better-auth のビルトイン状況

- `bearer` プラグイン: セッショントークンの Bearer 転送用。長期的 API key ではない
- `apiKey` プラグインは**存在しない**

### カスタム実装 (推奨)

```sql
-- app_passwords テーブル
CREATE TABLE IF NOT EXISTS app_passwords (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name TEXT NOT NULL,           -- "iOS Reminders" 等のラベル
  password_hash TEXT NOT NULL,  -- SHA-256 ハッシュ
  prefix TEXT NOT NULL,         -- 先頭 8 文字 (表示用)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at TEXT               -- NULL = active
);

CREATE INDEX IF NOT EXISTS idx_app_passwords_user ON app_passwords(user_id);
```

### セキュアな生成・検証

```ts
// src/auth/app-password.ts
export async function generateAppPassword(): Promise<{
  plain: string;
  hash: string;
  prefix: string;
}> {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  // Base62 エンコードで CalDAV クライアントが扱いやすい文字列に
  const plain = btoa(String.fromCharCode(...bytes))
    .replace(/[+/=]/g, "")
    .slice(0, 32);
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(plain),
  );
  const hash = [...new Uint8Array(hashBuffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return { plain, hash, prefix: plain.slice(0, 8) };
}

export async function verifyAppPassword(
  input: string,
  storedHash: string,
): Promise<boolean> {
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  const inputHash = [...new Uint8Array(hashBuffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return inputHash === storedHash;
}
```

### CalDAV Basic Auth との統合

```ts
// CalDAV ハンドラでの認証フロー
// username = user.email, password = App Password
async function authenticateCalDAV(
  authorization: string,
  db: D1Database,
): Promise<{ userId: string } | null> {
  // 1. Basic Auth デコード
  // 2. email でユーザー検索
  // 3. そのユーザーの有効な app_passwords を取得
  // 4. 各パスワードハッシュと照合
  // 5. last_used_at 更新
}
```

---

## 4. セッション管理

### 二系統の認証

| 方式 | 対象 | 実装 |
|------|------|------|
| Cookie ベース | Web UI (Hono JSX + htmx) | better-auth 標準 |
| App Password (Basic Auth) | CalDAV クライアント | カスタム実装 |

### Workers での Cookie 注意

- `advanced.useSecureCookies: true` を本番で有効に
- `*.workers.dev` は secure cookie の prefix が問題になりうる → **カスタムドメイン推奨**

---

## 5. Google OAuth スコープ設計

### Incremental Authorization

Google プロバイダに `include_granted_scopes: "true"` が組み込み済み。後からスコープ追加可能。

### 段階的スコープ

```ts
// Phase 1: ログインのみ
scope: [] // デフォルト: email, profile, openid

// Phase 3: Gmail + Google Calendar
scope: [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
]
```

### refresh_token

- `accessType: "offline"` + `prompt: "consent"` で確実に取得
- `account` テーブルの `refreshToken` カラムに暗号化保存
- ユーザーオフラインでも Gmail/Calendar API を叩ける

---

## 6. Hono JSX + htmx ログインフロー

### OAuth リダイレクト

```
1. /login で「Google でログイン」ボタンクリック
2. fetch POST /api/auth/sign-in/social { provider: "google", callbackURL: "/dashboard" }
3. レスポンスの URL に window.location.href でリダイレクト
4. Google 認証画面
5. /api/auth/callback/google にコールバック
6. better-auth がセッション Cookie 設定、callbackURL にリダイレクト
```

### ログインページ

```tsx
export function LoginPage() {
  return (
    <html>
      <head>
        <script src="https://unpkg.com/htmx.org@2.0.0"></script>
      </head>
      <body>
        <h1>Login</h1>
        <button
          onclick={`
            fetch('/api/auth/sign-in/social', {
              method: 'POST',
              headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({
                provider: 'google',
                callbackURL: '/dashboard'
              })
            })
            .then(r => r.json())
            .then(data => { if(data.url) window.location.href = data.url; })
          `}
        >
          Google でログイン
        </button>
      </body>
    </html>
  );
}
```

### 認証ガード middleware

```ts
import { createMiddleware } from "hono/factory";
import { createAuth } from "../auth/auth.js";

export const authGuard = createMiddleware<{
  Bindings: CloudflareBindings;
  Variables: { user: any; session: any };
}>(async (c, next) => {
  const auth = createAuth(c.env);
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });
  if (!session) {
    return c.redirect("/login");
  }
  c.set("user", session.user);
  c.set("session", session.session);
  await next();
});
```

### htmx で App Password 管理

```html
<form
  hx-post="/api/app-passwords"
  hx-target="#password-list"
  hx-swap="afterbegin"
>
  <input name="name" placeholder="iOS Reminders" required />
  <button type="submit">App Password を生成</button>
</form>
<div id="password-list"></div>
```

---

## 実装チェックリスト

1. [ ] `src/auth/auth.ts` — better-auth 設定 (D1 + Google OAuth)
2. [ ] `migrations/0003_auth.sql` — better-auth テーブル + app_passwords
3. [ ] `src/index.ts` — `/api/auth/**` ルート追加
4. [ ] `src/auth/app-password.ts` — App Password 生成・検証
5. [ ] `src/auth/caldav-token.ts` — App Password ベースの CalDAV 認証に書き換え
6. [ ] `src/middleware/auth-guard.ts` — Web UI 認証ガード
7. [ ] `src/pages/login.tsx` — ログインページ (Google OAuth)
8. [ ] `src/pages/dashboard.tsx` — ダッシュボード (App Password 管理)
9. [ ] `.dev.vars` — BETTER_AUTH_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET 等
10. [ ] テスト更新 — 既存テストの認証部分を App Password 対応に

### 環境変数 (.dev.vars)

```
BETTER_AUTH_URL=http://localhost:8787
BETTER_AUTH_SECRET=your-secret-key-at-least-32-chars
GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxx
CALDAV_USERNAME=test-user
CALDAV_PASSWORD=test-pass
```

### wrangler.jsonc に追加が必要な Secrets (本番)

```bash
wrangler secret put BETTER_AUTH_URL
wrangler secret put BETTER_AUTH_SECRET
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
```
