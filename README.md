# hono-caldav

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/gigun-dev/hono-caldav)

Cloudflare Workers 上で動く CalDAV サーバー。
iOS リマインダー/カレンダーなどの CalDAV クライアントからタスク・イベントを同期できる。

## 技術スタック

- **Runtime**: Cloudflare Workers
- **Framework**: Hono
- **Database**: Cloudflare D1 (SQLite)
- **Language**: TypeScript
- **Package Manager**: bun

## セットアップ

```sh
bun install
```

`.dev.vars` に認証情報を設定:

```
CALDAV_USERNAME=your_username
CALDAV_PASSWORD=your_password
```

ローカル D1 にマイグレーションを適用:

```sh
bun run db:migrate:local
```

## スクリプト一覧

| コマンド | 説明 |
|---|---|
| `bun run dev` | ローカル開発サーバーを起動 (wrangler dev, port 8787) |
| `bun run dev:proxy` | MKCALENDAR リライトプロキシを起動 (port 3001)。iOS 実機テスト時に使用 |
| `bun run tunnel` | cloudflared トンネルを起動。外部 (iOS 等) からローカルサーバーへアクセスする際に使用 |
| `bun run test` | Vitest でテスト実行 (Workers ランタイム上で動作) |
| `bun run deploy` | Cloudflare Workers に本番デプロイ (minify 付き) |
| `bun run cf-typegen` | `wrangler.jsonc` の bindings から `CloudflareBindings` 型を自動生成 |
| `bun run db:migrate:local` | ローカル D1 にマイグレーションを適用 |
| `bun run db:migrate:remote` | 本番 D1 にマイグレーションを適用 |

### 補足: 各スクリプトの詳細

#### `dev` — ローカル開発

```sh
bun run dev
```

`wrangler dev` を実行し、`http://localhost:8787` で開発サーバーが起動する。
D1 はローカルの SQLite (`.wrangler/state/v3/d1/` 配下) が使われる。

#### `dev:proxy` — MKCALENDAR プロキシ

```sh
bun run dev:proxy
```

workerd (wrangler dev) は `MKCALENDAR` メソッドをパースできないため、iOS からの `MKCALENDAR` リクエストを `POST` + `X-Caldav-Method` ヘッダーに書き換えて wrangler dev に転送するプロキシ。port 3001 で起動する。

iOS 実機テストの構成:

```
iOS --> cloudflared tunnel (port 3001) --> dev:proxy --> wrangler dev (port 8787)
```

#### `tunnel` — cloudflared トンネル

```sh
bun run tunnel
```

`dotenvx` 経由で `.env` のトンネル設定を読み込み、cloudflared トンネルを起動する。
iOS 実機など外部デバイスからローカルの開発サーバーにアクセスしたい場合に使用。

#### `db:migrate:local` / `db:migrate:remote` — マイグレーション

```sh
# ローカル DB に適用
bun run db:migrate:local

# 本番 DB に適用 (デプロイ前に実行)
bun run db:migrate:remote
```

`migrations/` ディレクトリの SQL ファイルを D1 に適用する。
ローカル DB をリセットしたい場合は `.wrangler/state/v3/d1/` を削除してから再適用する。

```sh
rm -rf .wrangler/state/v3/d1
bun run dev  # DB ファイルが再作成される
bun run db:migrate:local
```

**TablePlus などでローカル D1 を開く**: `.wrangler` 内の SQLite はパスが長いため、`local-d1.sqlite` を gitignore している。固定パスで開きたい場合は、一度 `bun run dev` で `.wrangler` を作ったあと:

```sh
ln -sf "$(find .wrangler/state/v3/d1 -name '*.sqlite' | head -1)" local-d1.sqlite
```

で symlink を作成してから TablePlus で `local-d1.sqlite` を開く。

## デプロイ

```sh
# 1. 本番 D1 にマイグレーション適用
bun run db:migrate:remote

# 2. Workers にデプロイ
bun run deploy
```

本番環境のシークレット設定:

```sh
bunx wrangler secret put CALDAV_USERNAME
bunx wrangler secret put CALDAV_PASSWORD
```

## テスト

```sh
bun run test
```

Vitest + `@cloudflare/vitest-pool-workers` で Workers ランタイム内でテスト実行。
D1 バインディングも実際の API が使われる。

## iOS リマインダーの接続

1. 設定 > リマインダー > アカウント > アカウントを追加 > その他
2. CalDAV アカウントを追加:
   - サーバー: `https://<your-worker>.workers.dev`
   - ユーザ名 / パスワード: 設定した認証情報と同じ値

## 型生成

D1 バインディングなどの型定義を更新したい場合:

```sh
bun run cf-typegen
```

`wrangler.jsonc` の設定から `CloudflareBindings` インターフェースを自動生成する。
