# CLAUDE.md — hono-caldav

## プロジェクト概要

CalDAV ベースの AI タスク管理 SaaS。
Cloudflare Workers + Hono + D1 で構築。iOS リマインダー/カレンダーや MCP から接続でき、
Google 連携で Gmail タスク抽出や自然言語 CRUD を提供する。

詳細スペック: `docs/SPEC.md`
各フェーズの実装ガイド: `docs/phase{1-4}-guide.md`

## コマンド

- `bun run dev` — ローカル開発サーバー
- `bun run test` — テスト実行 (Vitest + Workers pool)
- `bun run deploy` — Cloudflare Workers にデプロイ
- `bun run cf-typegen` — CloudflareBindings 型を再生成

## アーキテクチャ

```text
src/
├── index.tsx                # Hono app エントリポイント (fetch + email + scheduled handlers)
├── auth/
│   ├── auth.ts              # better-auth (Google OAuth + D1)
│   ├── app-password.ts      # App Password (PBKDF2, 100k iterations)
│   └── caldav-token.ts      # CalDAV Basic Auth (App Password + legacy fallback)
├── middleware/
│   └── auth-guard.ts        # Session-based auth guard
├── caldav/
│   ├── handlers.ts          # CalDAV HTTP ハンドラ (PROPFIND, REPORT, PUT, GET, DELETE, PROPPATCH, MKCOL)
│   ├── storage.ts           # D1 ストレージ層 (Calendar, CalendarObject, CalendarChange CRUD)
│   ├── ical.ts              # ICS パース (UID 抽出、VTODO/VEVENT 検証)
│   ├── query-filter.ts      # Calendar-query フィルタエンジン (comp/prop/time-range/text-match, RRULE 展開)
│   └── xml.ts               # DAV XML レスポンスビルダ
├── mcp/
│   └── handler.ts           # MCP Server (JSON-RPC, 10 tools)
├── ai/
│   └── natural-language.ts  # Workers AI 自然言語 CRUD
├── scheduling/
│   ├── api.ts               # iTIP/iMIP API エンドポイント
│   ├── itip.ts              # iTIP 生成/パース (RFC 5546)
│   ├── storage.ts           # Attendee/Feedback CRUD
│   ├── email-sender.ts      # Resend API iMIP 送信
│   └── email-worker.ts      # Email Worker iMIP 受信
├── integrations/
│   ├── gmail.ts             # Gmail API client
│   ├── google-auth.ts       # OAuth token refresh
│   ├── google-calendar.ts   # Google Calendar API client
│   └── gmail-worker.ts      # Gmail polling pipeline
├── webhooks/
│   └── notify.ts            # Webhook 通知 (HMAC-SHA256 署名)
├── sharing/
│   └── api.ts               # カレンダー共有 API (share/list/revoke)
├── setup/
│   └── mobileconfig.ts      # iOS mobileconfig 生成
└── pages/
    ├── login.tsx             # Google OAuth ログインページ
    ├── dashboard.tsx         # App Password 管理
    └── setup.tsx             # セットアップガイド
```

### データフロー

1. リクエスト → `handlers.ts` (認証 → ルーティング)
2. `storage.ts` で D1 に CRUD
3. `xml.ts` で DAV XML レスポンス組み立て
4. ICS データはパースせずそのまま保存 (メタデータは最小限)

### DB スキーマ (D1/SQLite)

- `calendars` — カレンダーコレクション (user_id, name, synctoken)
- `calendar_objects` — VTODO/VEVENT (calendar_id, uid, etag, ics_data)
- `calendarchanges` — 変更ログ (operation: 1=add, 2=update, 3=delete) ← sync-collection 用
- `app_passwords` — App Password (PBKDF2 hash, prefix, revoked_at)
- `attendees` — iTIP attendee tracking (partstat, rsvp)
- `scheduling_feedback` — DECLINED/COUNTER フィードバック
- `gmail_sync_state` — Gmail polling 状態
- `webhooks` — Webhook 登録 (url, secret, event_types, active)

- `calendar_shares` — カレンダー共有 (calendar_id, owner_id, shared_with_id, permission)

- `user_tiers` — ユーザー課金 tier (free/pro, stripe_customer_id, stripe_subscription_id)

マイグレーションは `migrations/` ディレクトリ (0001-0012)。

### 同期方式

Sabre/Nextcloud スタイルの変更ログ (`calendarchanges` テーブル) による差分 sync。
sync-token はカレンダーごとの整数カウンタ。

## コーディング規約

- フォーマッタ: Prettier (タブインデント)
- TypeScript strict モード
- `.js` 拡張子付きインポート (`./storage.js`)
- Hono の型: `Hono<{ Bindings: CloudflareBindings }>`
- テストは `test/` ディレクトリ、`SELF.fetch()` でインテグレーションテスト (364+ テスト / 18 ファイル)

## 主要機能

- CalDAV CRUD (PROPFIND, REPORT, PUT, GET, DELETE, PROPPATCH, MKCOL)
- Calendar-query REPORT フィルタリング (comp-filter, prop-filter, time-range, text-match)
- RRULE 繰り返しイベント展開 (time-range クエリ内)
- sync-collection REPORT (差分同期)
- ETag ベース 304 Not Modified
- カレンダーコレクション DELETE
- Duplicate UID 拒否 (409 Conflict)
- Depth:infinity 拒否 (403 Forbidden)
- Webhook 通知 (HMAC-SHA256 署名、タスク作成/更新/完了/削除)
- カレンダー共有 (share/list/revoke、IDOR 防止)
- `/health` エンドポイント (D1 接続確認)
- MCP Server (10 tools, JSON-RPC)
- Workers AI 自然言語 CRUD
- Gmail タスク抽出 + Google Calendar 連携
- iTIP/iMIP スケジューリング (SaaS as Organizer)
- iOS mobileconfig 自動生成

## 認証 (3系統)

1. **Web / API**: better-auth (Google OAuth) → session cookie
2. **CalDAV**: App Password (PBKDF2) + Basic Auth — ダッシュボードで発行/リボーク
3. **MCP**: Bearer token (`MCP_TOKEN` 環境変数)

レガシー fallback: `CALDAV_USERNAME` / `CALDAV_PASSWORD` 環境変数 (App Password 未設定時)。
環境変数テンプレート: `.dev.vars.example`
