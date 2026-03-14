# 使い方ガイド

CalDAV VTODO サーバーのローカル・本番での接続方法とクライアント設定です。

## 前提

- **Bun** が必要です（Cloudflare Workers + D1 の開発環境）
- カレンダーとリマインダーは実装済み。CalDAV 対応クライアントで利用可能
- **単一アカウント**のみ。複数アカウントには未対応
- 認証は Basic 認証のみ（将来 Better Auth + OAuth / Gmail 連携を想定）

---

## 本番環境での接続

| 項目 | 値 |
|------|-----|
| **URL** | `https://caldav.gigun-dev.workers.dev/` |
| **ユーザ名** | `admin` |
| **パスワード** | `changeme` |

CalDAV 対応クライアントで上記の URL と認証情報を設定すれば利用できます。

---

## ローカル環境での接続

Workers では HTTP 非標準メソッドの **MKCALENDAR** が使えないため、ローカル開発時は **proxy サーバー** を立てて回避しています。手順は次の 4 ステップです。

### 1. D1 マイグレーション（ローカル DB）

```sh
bun run db:migrate:local
```

### 2. 開発サーバー起動

```sh
bun run dev
```

### 3. Proxy サーバー起動（別ターミナル）

```sh
bun run dev:proxy
```

### 4. Cloudflared でトンネル（別ターミナル）

[Cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/) をインストールした上で:

```sh
cloudflared tunnel --url http://localhost:3001
```

表示される **トンネル URL**（例: `https://xxxx-xx-xx-xx-xx.xx.trycloudflare.com`）が、クライアントから接続する際の **CalDAV の URL** になります。

- **ユーザ名** / **パスワード**: 本番と同じ（`admin` / `changeme`）
- `.dev.vars` の `CALDAV_USERNAME` / `CALDAV_PASSWORD` と一致させておく

---

## クライアント側の設定

### iOS（リマインダー / カレンダー）

1. **設定** → **リマインダー**（または **カレンダー**）→ **アカウント** → **アカウントを追加** → **その他**
2. **CalDAV アカウント** を追加
   - **サーバー**: 上記の本番 URL または cloudflared のトンネル URL
   - **ユーザ名** / **パスワード**: `admin` / `changeme`（本番・ローカル共通）

### Android

- **Google カレンダー** は CalDAV 非対応のため、このサーバーには接続できません。
- **DAVx⁵** など CalDAV 対応クライアントを使用してください。
  - [DAVx⁵ (F-Droid)](https://f-droid.org/packages/at.bitfire.davdroid/)
  - 参考: [CalDAV クライアント設定例](https://intaa.net/archives/39954)

---

## 認証まわり（.dev.vars）

ローカル開発用の認証情報は `.dev.vars` に書きます。リポジトリに含めないよう `.gitignore` に追加しておいてください。

```env
CALDAV_USERNAME=admin
CALDAV_PASSWORD=changeme
```

本番では Wrangler のシークレットで設定します（README の「デプロイ」を参照）。

---

## まとめ

| 環境 | CalDAV URL | ユーザ | パスワード |
|------|------------|--------|------------|
| 本番 | `https://caldav.gigun-dev.workers.dev/` | admin | changeme |
| ローカル | `cloudflared tunnel --url http://localhost:3001` で表示される URL | admin | changeme |

DB・サーバー・proxy をローカルで起動し、最後にトンネル用 URL と Basic 認証で、CalDAV 対応クライアントから接続して動作確認できます。
