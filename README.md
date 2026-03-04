# hono-vtodo

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/gigun-dev/hono-vtodo)

Cloudflare Workers 上で動く CalDAV VTODO サーバー。
iOS リマインダーなどの CalDAV クライアントからタスクを同期できる。

## 技術スタック

- **Runtime**: Cloudflare Workers
- **Framework**: Hono
- **Database**: Cloudflare D1 (SQLite)
- **Language**: TypeScript

## セットアップ

```sh
bun install
```

### ローカル開発

`.dev.vars` に認証情報を設定:

```
CALDAV_USERNAME=xxxxxx
CALDAV_PASSWORD=xxxxxx
```

D1 マイグレーション適用 & 開発サーバー起動:

```sh
# vtodo-db は wrangler.jsonc の d1_databases[].database_name と一致させる
npx wrangler d1 migrations apply vtodo-db --local
bun run dev
```

### iOS リマインダーの設定

1. 設定 > リマインダー > アカウント > アカウントを追加 > その他
2. CalDAV アカウントを追加:
   - サーバー: `https://<your-worker>.workers.dev`
   - ユーザ名 / パスワード: `.dev.vars` と同じ値

## テスト

```sh
bun run test
```

Vitest + `@cloudflare/vitest-pool-workers` で Workers ランタイム内でテスト実行。
D1 バインディングも実際の API が使われる。

## デプロイ

```sh
# 本番 D1 にマイグレーション適用
npx wrangler d1 migrations apply vtodo-db --remote

# Workers にデプロイ
bun run deploy
```

本番環境のシークレット設定:

```sh
npx wrangler secret put CALDAV_USERNAME
npx wrangler secret put CALDAV_PASSWORD
```

## 型生成

```sh
bun run cf-typegen
```
