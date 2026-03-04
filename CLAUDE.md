# CLAUDE.md — hono-vtodo

## プロジェクト概要

Cloudflare Workers + Hono + D1 で構築した CalDAV VTODO サーバー。
iOS リマインダーからタスクを同期する学習用プロジェクト。

## コマンド

- `bun run dev` — ローカル開発サーバー
- `bun run test` — テスト実行 (Vitest + Workers pool)
- `bun run deploy` — Cloudflare Workers にデプロイ
- `bun run cf-typegen` — CloudflareBindings 型を再生成

## アーキテクチャ

```text
src/
├── index.ts                 # Hono app エントリポイント
├── auth/caldav-token.ts     # Basic 認証 (環境変数ベース)
└── caldav/
    ├── handlers.ts          # CalDAV HTTP ハンドラ (PROPFIND, REPORT, PUT, GET, DELETE, PROPPATCH)
    ├── storage.ts           # D1 ストレージ層 (Calendar, CalendarObject, CalendarChange CRUD)
    ├── ical.ts              # ICS パース (UID 抽出、VTODO 検証)
    └── xml.ts               # DAV XML レスポンスビルダ
```

### データフロー

1. リクエスト → `handlers.ts` (認証 → ルーティング)
2. `storage.ts` で D1 に CRUD
3. `xml.ts` で DAV XML レスポンス組み立て
4. ICS データはパースせずそのまま保存 (メタデータは最小限)

### DB スキーマ (D1/SQLite)

- `calendars` — カレンダーコレクション (user_id, name, synctoken)
- `calendar_objects` — VTODO (calendar_id, uid, etag, ics_data)
- `calendarchanges` — 変更ログ (operation: 1=add, 2=update, 3=delete) ← sync-collection 用

マイグレーションは `migrations/` ディレクトリ。

### 同期方式

Sabre/Nextcloud スタイルの変更ログ (`calendarchanges` テーブル) による差分 sync。
sync-token はカレンダーごとの整数カウンタ。

## コーディング規約

- フォーマッタ: Prettier (タブインデント)
- TypeScript strict モード
- `.js` 拡張子付きインポート (`./storage.js`)
- Hono の型: `Hono<{ Bindings: CloudflareBindings }>`
- テストは `test/` ディレクトリ、`SELF.fetch()` でインテグレーションテスト

## 認証

環境変数 `CALDAV_USERNAME` / `CALDAV_PASSWORD` による単一ユーザー Basic 認証。
ローカルでは `.dev.vars` から読み込み。
