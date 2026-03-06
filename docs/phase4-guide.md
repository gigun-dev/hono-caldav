# Phase 4: iTIP/iMIP + Email Routing ガイド

## 1. iTIP (RFC 5546) 概要

### METHOD 一覧

| METHOD | 方向 | 用途 | 実装優先度 |
|--------|------|------|-----------|
| REQUEST | Organizer -> Attendee | 招待の送信・更新 | 必須 |
| REPLY | Attendee -> Organizer | 参加ステータスの回答 | 必須 |
| CANCEL | Organizer -> Attendee | キャンセル通知 | 中 |
| COUNTER | Attendee -> Organizer | 代替時間の提案 | 必須 (自動ACCEPT) |
| DECLINECOUNTER | Organizer -> Attendee | 提案の却下 | 不要 (常にACCEPTするため) |
| PUBLISH | Organizer -> 全体 | 公開 (出欠管理なし) | 低 |
| REFRESH | Attendee -> Organizer | 最新情報リクエスト | 低 |
| ADD | Organizer -> Attendee | インスタンス追加 | 低 |

### PARTSTAT (参加ステータス)

- **NEEDS-ACTION** — 未回答 (デフォルト)
- **ACCEPTED** — 参加
- **DECLINED** — 不参加
- **TENTATIVE** — 仮参加

### 「SaaS as ORGANIZER」モデル

1. SaaS が ORGANIZER (`mailto:scheduling@yourdomain.com`) として VEVENT 作成
2. ATTENDEE に iTIP REQUEST をメール (iMIP) で送信
3. ATTENDEE が REPLY で回答 → `scheduling@yourdomain.com` にメール到着
4. SaaS がメールを受信・パースして PARTSTAT 更新

**iOS カレンダー**: iMIP の `text/calendar` 添付を検出し「参加/仮参加/不参加」ボタンを表示。REPLY を自動メール送信。

**Gmail**: メール内にインラインで RSVP ボタン (Yes/Maybe/No) を表示。

---

## 2. iMIP (RFC 6047) メール構造

### REQUEST メールの例

```
From: scheduling@yourdomain.com
To: attendee@example.com
Subject: Invitation: チーム定例会議
MIME-Version: 1.0
Content-Type: text/calendar; charset=UTF-8; method=REQUEST

BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//hono-caldav//EN
METHOD:REQUEST
BEGIN:VEVENT
UID:unique-event-id@yourdomain.com
DTSTART:20260310T100000Z
DTEND:20260310T110000Z
SUMMARY:チーム定例会議
ORGANIZER;CN=Scheduling:mailto:scheduling@yourdomain.com
ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:attendee@example.com
END:VEVENT
END:VCALENDAR
```

### Subject の規則

- REQUEST → `Invitation: {SUMMARY}`
- REPLY → `Re: {SUMMARY}`
- CANCEL → `Cancelled: {SUMMARY}`

---

## 3. Cloudflare Email Routing

### Email Worker — 受信処理

```typescript
import PostalMime from "postal-mime";

export default {
  async email(message, env, ctx) {
    const parser = new PostalMime.default();
    const rawEmail = new Response(message.raw);
    const email = await parser.parse(await rawEmail.arrayBuffer());

    // text/calendar パートを抽出
    const calendarPart = email.attachments?.find(
      (a) => a.contentType?.includes("text/calendar")
    );

    if (calendarPart) {
      const icsData = new TextDecoder().decode(calendarPart.content);
      // iCalendar パースして PARTSTAT 更新
      // env.DB で D1 にアクセス可能
    }
  },
};
```

**設定**: Cloudflare Dashboard > Email Routing > Email Workers で `scheduling@yourdomain.com` をバインド。

**D1 アクセス**: Email Worker は通常の Workers と同じバインディング。`env.DB` で D1 にアクセス可能。

### メール送信

**Cloudflare send_email バインディング**

```jsonc
// wrangler.jsonc に追加
{
  "send_email": [{ "name": "EMAIL" }]
}
```

```typescript
import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext";

const msg = createMimeMessage();
msg.setSender({ name: "Scheduling", addr: "scheduling@yourdomain.com" });
msg.setRecipient("attendee@example.com");
msg.setSubject("Invitation: チーム定例会議");
msg.addMessage({
  contentType: "text/calendar; charset=UTF-8; method=REQUEST",
  data: icsData,
});

const message = new EmailMessage(
  "scheduling@yourdomain.com",
  "attendee@example.com",
  msg.asRaw()
);
await env.EMAIL.send(message);
```

**制限**: send_email は verified destination address にしか送れない制約あり。

**外部サービス推奨**: 任意の外部アドレスに送るなら **Resend** を推奨。

| サービス | 特徴 |
|----------|------|
| **Resend** | モダン API、CF 公式チュートリアルあり、fetch() で連携 |
| Postmark | 高い到達率 |
| SendGrid | 大量送信向け |

※ MailChannels は 2024 年に CF との無料連携を終了。非推奨。

---

## 4. CalDAV Scheduling (RFC 6638)

### Inbox / Outbox

RFC 6638 は2つの特殊コレクションを追加:
- **Schedule Outbox** (`/dav/principals/{user}/outbox/`): クライアントが iTIP を POST
- **Schedule Inbox** (`/dav/principals/{user}/inbox/`): サーバーが受信 iTIP を配置

### Implicit Scheduling (推奨)

- クライアントが ORGANIZER + ATTENDEE 付きイベントを **PUT するだけ**
- サーバーが変更を検知し、iTIP メッセージを自動生成・配送
- iOS カレンダーはこのモデルを前提

### Explicit Scheduling

- クライアントが iTIP メッセージを Outbox に POST
- 主に FREEBUSY リクエスト用
- 多くのクライアントはあまり使わない

---

## 5. 実装スコープ

### Phase 4a: iTIP + iMIP (ハッカソン)

HTTP API + iMIP で SaaS as Organizer モデルを実装。

**必須:**
- [x] Resend で iMIP REQUEST メール送信
- [x] Email Worker で iMIP REPLY メール受信
- [x] postal-mime + iCalendar パース
- [x] VEVENT 作成 API (ORGANIZER + ATTENDEE 付き)
- [x] PARTSTAT 更新ロジック (REPLY 処理)
- [x] COUNTER 自動 ACCEPT (ユーザーが時間変更 → 無条件で更新 → 新 REQUEST 返却)
- [x] DECLINE フィードバック蓄積 (タスク抽出精度改善)

**不要:**
- [ ] DECLINECOUNTER (常に ACCEPT するため不要)
- [ ] FREEBUSY (POST to Outbox)
- [ ] CalDAV Scheduling Inbox/Outbox (RFC 6638)
- [ ] Implicit Scheduling

### COUNTER 自動 ACCEPT の実装

「SaaS as Organizer」モデルでは、Organizer が機械なので「ユーザーは常に正しい」ポリシー:

1. Email Worker で COUNTER メソッドの iMIP メールを受信
2. COUNTER の DTSTART/DTEND を抽出
3. 元の VEVENT を新しい日時で更新 (D1)
4. 全 ATTENDEE に新しい REQUEST を iMIP で送信

```typescript
// COUNTER 処理の疑似コード
if (method === "COUNTER") {
  const newStart = extractDtstart(counterIcs);
  const newEnd = extractDtend(counterIcs);
  // イベントを更新
  await updateEventDateTime(db, uid, newStart, newEnd);
  // 新しい REQUEST を全 attendee に送信
  await sendUpdatedRequest(env, uid);
}
```

### Phase 4b: CalDAV Scheduling (将来)

- Scheduling Inbox/Outbox プロパティ公開
- PUT ハンドラで ORGANIZER/ATTENDEE 変更検知
- Implicit Scheduling 実装

### DB スキーマ追加

```sql
CREATE TABLE attendees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  calendar_object_id INTEGER NOT NULL REFERENCES calendar_objects(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  partstat TEXT NOT NULL DEFAULT 'NEEDS-ACTION',
  rsvp INTEGER NOT NULL DEFAULT 1,
  sent_at TEXT,
  replied_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_attendees_object ON attendees(calendar_object_id);
CREATE INDEX idx_attendees_email ON attendees(email);
```

### npm パッケージ

- `postal-mime` — MIME パース (Email Worker で使用)
- `mimetext` — MIME メール構築
- `resend` — メール送信 API
