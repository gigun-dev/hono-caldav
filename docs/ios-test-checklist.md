# iOS 実機テストチェックリスト

## 準備

1. `bun run dev` でローカルサーバー起動
2. `bun wrangler d1 migrations apply hono-caldav --local` でDB初期化
3. Proxyman でiPhoneのHTTPプロキシを設定
4. ブラウザで `http://localhost:8787/login` にアクセス → Google OAuth ログイン
5. `/dashboard` で App Password を生成 → メモ

## Phase 1: 認証基盤

### 1.1 Google OAuth ログイン
- [ ] `/login` ページが表示される
- [ ] Google OAuth ボタンでログインフローが完了する
- [ ] `/dashboard` にリダイレクトされ、ユーザー名・メールが表示される

### 1.2 App Password 管理
- [ ] App Password を「iOS」という名前で生成できる
- [ ] 生成されたパスワードが表示される（一度だけ）
- [ ] App Password のリスト表示に prefix が見える
- [ ] App Password をリボークできる

## Phase 2: CalDAV 接続 (iOS リマインダー/カレンダー)

### 2.1 mobileconfig 経由セットアップ
- [ ] `/setup` ページが表示される
- [ ] 「iOS プロファイルをダウンロード」でmobileconfig がダウンロードされる
- [ ] 設定 > プロファイル からインストールできる
- [ ] CalDAV アカウントが追加される

### 2.2 手動セットアップ（代替）
- [ ] 設定 > カレンダー > アカウント > CalDAV で手動追加
  - サーバー: `localhost:8787`（またはトンネルURL）
  - ユーザー名: Google メールアドレス
  - パスワード: App Password

### 2.3 CalDAV Discovery
確認: Proxyman で以下のリクエスト/レスポンスを確認

- [ ] `PROPFIND /.well-known/caldav` → 301 → `/dav/`
- [ ] `PROPFIND /dav/` → 207 (current-user-principal を含む)
- [ ] `PROPFIND /dav/principals/{email}` → 207 (calendar-home-set を含む)
- [ ] `PROPFIND /dav/projects/` (Depth:1) → 207 (カレンダー一覧)
- [ ] `OPTIONS /dav/` → DAV ヘッダー含む

### 2.4 カレンダー作成 (MKCALENDAR)
- [ ] iOS カレンダーアプリからカレンダーを新規作成
- [ ] Proxyman: MKCALENDAR (or POST + X-Caldav-Method) リクエスト確認
- [ ] wrangler logs: カレンダー作成ログ

### 2.5 タスク CRUD (iOS リマインダー)
- [ ] リマインダーアプリでタスク作成 → PUT リクエスト確認
- [ ] タスクのタイトル変更 → PUT リクエスト確認
- [ ] タスク完了 → PUT リクエスト (STATUS:COMPLETED)
- [ ] タスク削除 → DELETE リクエスト確認
- [ ] 同期: 別デバイスまたはアプリ再起動で変更が反映される

### 2.6 Sync-Collection
- [ ] 初回同期後に sync-token が返る
- [ ] 変更後の差分同期 (REPORT sync-collection) で変更分のみ返る
- [ ] Proxyman: sync-token の値が増加していることを確認

### 2.7 ETag / If-Match
- [ ] タスク更新時に If-Match ヘッダーが送信される
- [ ] サーバーが ETag を正しく返す
- [ ] 競合時に 412 Precondition Failed が返る

## Phase 3: AI Integration

### 3.1 MCP 接続
- [ ] `curl -X POST http://localhost:8787/mcp -H "Authorization: Bearer {MCP_TOKEN}" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` でツール一覧取得

### 3.2 自然言語 CRUD
- [ ] `/api/tasks/natural` に POST → タスク作成
  ```json
  {"calendarId": 1, "input": "明日の10時にミーティング"}
  ```
- [ ] 作成されたタスクが iOS リマインダーに同期される

## Phase 4: iTIP/iMIP (要 Resend API Key + Email Routing)

### 4.1 スケジューリング API
- [ ] `/api/scheduling/events` に POST → イベント作成 + attendee 設定
- [ ] RESEND_API_KEY 設定時、attendees にメール送信される

### 4.2 REPLY 処理
- [ ] `/api/scheduling/reply` にiMIP REPLY POSTで PARTSTAT 更新

### 4.3 COUNTER 自動 ACCEPT
- [ ] `/api/scheduling/counter` に COUNTER POST → 時間変更が自動適用

## 確認ポイント (Proxyman)

### 注目すべきヘッダー
- `DAV: 1, calendar-access, sync-collection, extended-mkcol`
- `Content-Type: application/xml; charset=utf-8`
- `ETag: "..."` (GET/PUT レスポンス)
- `WWW-Authenticate: Basic realm="CalDAV"` (401時)

### 注目すべきステータスコード
- 207 Multi-Status (PROPFIND, REPORT)
- 201 Created (PUT 新規)
- 204 No Content (PUT 更新)
- 301 Moved (well-known redirect)
- 401 Unauthorized (認証失敗)
- 412 Precondition Failed (ETag 不一致)

## トラブルシューティング

### iOS が接続できない
1. `bun run dev` のログで 401 が出ていないか確認
2. App Password が正しいか確認（revoked でないか）
3. Proxyman でリクエスト/レスポンスを確認
4. `DEBUG=true` を `.dev.vars` に追加してリクエストボディをログ出力

### カレンダーが表示されない
1. Discovery フロー (2.3) を一つずつ確認
2. `PROPFIND /dav/projects/` の Depth:1 レスポンスにカレンダーが含まれているか
3. componentType が VTODO/VEVENT のどちらか確認
