# Phase 5+ 計画草案

## 現状 (Phase 7b 完了時点)

- CalDAV Server: RFC 4791 準拠 (calendar-query filter, RRULE 展開, Depth:infinity 拒否, Duplicate UID 拒否)
- 認証: better-auth + Google OAuth + App Password + MCP Bearer token
- AI: Workers AI 自然言語 CRUD + Gmail タスク抽出
- Scheduling: iTIP/iMIP (SaaS as Organizer)
- Webhook: HMAC-SHA256 署名付き通知
- 監視: /health エンドポイント + 構造化 JSON ログ
- テスト: 292+テスト / 13ファイル

### 完了した Phase
- **Phase 5a** ✅ calendar-query filter (comp/prop/time-range/text-match), Duplicate UID 拒否, Depth:infinity, 非 ASCII, カレンダー削除
- **Phase 5c** ✅ RRULE 繰り返しイベント展開 (time-range クエリ内)
- **Phase 6b** ✅ /health エンドポイント, 構造化ログ (requestId, durationMs)
- **Phase 7b** ✅ Webhook 通知 (HMAC-SHA256, タスク CRUD イベント)

---

## Phase 5a: CalDAV RFC 完全準拠 ✅ 完了

### 背景
CalDAVTester (Apple) は163のテストスクリプトを持つ。現在の実装はコアプロトコルをカバーしているが、
calendar-query REPORT のフィルタリングが未実装。これは iOS/macOS クライアントが検索・フィルタに使用する重要機能。

### 実装項目

1. **calendar-query REPORT フィルタリング** (HIGH)
   - comp-filter: VCALENDAR > VEVENT, VCALENDAR > VTODO
   - time-range: DTSTART/DTEND/DUE/COMPLETED による期間フィルタ
   - prop-filter: SUMMARY, CATEGORIES 等のプロパティフィルタ
   - text-match: contains, equals, starts-with, ends-with

2. **Duplicate UID 拒否** (MEDIUM)
   - 同一カレンダー内で異なる .ics ファイルに同じ UID → 409 Conflict

3. **Depth:infinity 明示的拒否** (LOW)
   - 403 Forbidden を返す (現在は 0 にフォールバック)

4. **非 ASCII コンテンツ対応** (MEDIUM)
   - CJK 文字、絵文字の SUMMARY/DESCRIPTION テスト
   - UTF-8 エンコーディングの一貫性確認

5. **カレンダー削除** (MEDIUM)
   - DELETE on collection `/dav/projects/{id}/`

### テスト計画
- calendar-query フィルタテスト: +20テスト
- Duplicate UID: +3テスト
- Non-ASCII: +5テスト
- 推定: 216 → 250+ テスト

---

## Phase 5b: MCP OAuth (workers-oauth-provider) — 未着手

### 背景
現在の MCP は Bearer token (環境変数) 認証。MCP 標準 OAuth に移行すると、
Claude Desktop 等から動的にユーザー認証できるようになる。

### 実装項目

1. **workers-oauth-provider セットアップ**
   - Authorization Code Flow + PKCE
   - Durable Objects でトークン管理

2. **MCP OAuth フロー**
   - `/mcp/authorize` — 認可エンドポイント
   - `/mcp/token` — トークン発行
   - `/mcp/callback` — コールバック

3. **per-user MCP トークン**
   - user_id とトークンの紐付け
   - スコープ制限 (read-only, read-write)

### 依存
- `workers-oauth-provider` パッケージ
- Durable Objects (Cloudflare Workers Paid plan)

---

## Phase 5c: Recurring Events (RRULE) ✅ 完了

### 背景
現在は単発イベント/タスクのみ。RRULE 対応で繰り返しイベントを扱えるようになる。

### 実装項目

1. **RRULE 保存** — ICS データとしてそのまま保存 (現在通り)
2. **time-range クエリでの展開** — calendar-query 時に RRULE を展開
3. **EXDATE 対応** — 例外日の除外
4. **THIS-AND-FUTURE 修正** — 繰り返しの途中からの変更

### 依存
- ical.js の RRULE 展開機能 (既に依存済み)
- Phase 5a の calendar-query time-range が前提

---

## Phase 6: プロダクション対応 — 一部完了

### 6a: パフォーマンス — 未着手

1. **D1 クエリ最適化**
   - calendar_objects に (calendar_id, uid) 複合インデックス
   - calendarchanges に (calendar_id, synctoken) インデックス
   - バッチ INSERT for attendees

2. **キャッシュ**
   - ETag ベースの 304 Not Modified
   - PROPFIND レスポンスのキャッシュ (short TTL)

3. **レートリミット**
   - per-user API レートリミット
   - Cloudflare Rate Limiting Rules

### 6b: 監視・運用 ✅ 完了

1. **Structured Logging**
   - JSON ログ + request-id
   - エラートラッキング (Sentry Workers)

2. **ヘルスチェック**
   - `/health` エンドポイント (D1 接続確認)

3. **メトリクス**
   - Workers Analytics Engine
   - CalDAV リクエスト成功率
   - sync-collection 使用頻度

### 6c: マルチテナント — 未着手

1. **per-user D1 分割** (10GB 上限対策)
   - ユーザー数 1000+ で検討
   - DB ルーティングレイヤー

2. **Stripe 課金統合**
   - Free tier: 1 calendar, 100 tasks
   - Pro tier: unlimited calendars, Gmail polling

---

## Phase 7: エコシステム拡張 — 一部完了

### 7a: CalDAV Client SDK (tsdav 統合) — 未着手

- 外部から CalDAV プロトコル経由でアクセスするクライアントライブラリ
- tsdav を使った参考実装・テスト

### 7b: Webhook 通知 ✅ 完了

- タスク作成/更新/完了/削除時に外部サービスへ通知
- HMAC-SHA256 署名付きリクエスト
- Per-user webhook 登録・管理

### 7c: カレンダー共有 — 未着手

- CalendarServer Sharing Extensions
- invite/allowed-sharing-modes

---

## 優先度マトリクス

| Phase | 項目 | 難易度 | ユーザー価値 | 状態 |
|-------|------|--------|-------------|------|
| 5a | calendar-query フィルタ | 中 | 高 | ✅ 完了 |
| 5a | 非 ASCII 対応 | 低 | 中 | ✅ 完了 |
| 5b | MCP OAuth | 高 | 高 | 未着手 |
| 5c | RRULE 展開 | 高 | 高 | ✅ 完了 |
| 6a | D1 最適化 | 中 | 中 | 未着手 |
| 6b | 監視・ログ | 低 | 中 | ✅ 完了 |
| 6c | マルチテナント | 高 | 低 (初期) | 未着手 |
| 7a | CalDAV Client SDK | 中 | 中 | 未着手 |
| 7b | Webhook 通知 | 中 | 中 | ✅ 完了 |
| 7c | カレンダー共有 | 中 | 中 | 未着手 |
