# Phase 3: AI Integration + MCP ガイド

## 1. MCP + Hono 公式統合

### SDK v2 パッケージ構成

| パッケージ | 役割 |
|---|---|
| `@modelcontextprotocol/core` | 型定義・プロトコル基盤 |
| `@modelcontextprotocol/server` | McpServer, WebStandardStreamableHTTPServerTransport |
| `@modelcontextprotocol/client` | クライアント実装 |
| `@modelcontextprotocol/hono` | Hono ミドルウェア (createMcpHonoApp, hostHeaderValidation) |
| `@modelcontextprotocol/node` | Node.js アダプタ (内部で @hono/node-server 使用) |

### なぜ Hono が公式依存か

`WebStandardStreamableHTTPServerTransport` は Web Standard API (`Request`, `Response`, `ReadableStream`) で構築。
Hono も Web Standard API ベース。`transport.handleRequest(c.req.raw)` で完璧に噛み合う。

### Streamable HTTP Transport

MCP の現在の標準トランスポート:
- **POST**: JSON-RPC メッセージ送受信
- **GET**: SSE ストリーム確立 (サーバー通知)
- セッション管理: `sessionIdGenerator` で Stateful/Stateless 切り替え
- JSON-only モード: SSE なしも可能

### SSE Transport (レガシー) との違い

| 項目 | Streamable HTTP (推奨) | SSE (非推奨) |
|---|---|---|
| リクエスト送信 | HTTP POST | 別途 POST |
| サーバー通知 | POST レスポンス内 SSE or GET SSE | 常に SSE |
| セッション管理 | 組み込み | なし |
| SDK v2 | 主要実装 | サーバー側削除 |

---

## 2. MCP Server on Cloudflare Workers

### 3つのアプローチ

| アプローチ | Stateful? | DO 必要? | 用途 |
|---|---|---|---|
| `createMcpHandler()` (agents SDK) | No | No | **推奨**: ステートレスツール |
| `McpAgent` (agents SDK) | Yes | Yes | セッション状態保持 |
| `WebStandardStreamableHTTPServerTransport` 直接 | No | No | 完全制御 |

### このプロジェクトでは Durable Objects 不要

CalDAV の CRUD はステートレス (D1 に状態がある)。`createMcpHandler()` で十分。

### 認証

最初は **Bearer token** で簡易実装。後から OAuth に移行可能:

```typescript
app.use('/mcp', async (c, next) => {
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ') || auth.slice(7) !== c.env.MCP_TOKEN) {
    return c.text('Unauthorized', 401);
  }
  await next();
});
```

将来的には `workers-oauth-provider` ライブラリで MCP 標準 OAuth に移行。

---

## 3. MCP Tools 設計

### storage.ts を直接呼ぶ (推奨)

```
iOS リマインダー → CalDAV (XML) → handlers.ts → storage.ts → D1
Claude/Cursor   → MCP (JSON-RPC) → mcp-server.ts → storage.ts → D1
```

CalDAV の XML オーバーヘッドを回避。同一 Worker 内で効率的にデータアクセス。

### ツール一覧

```typescript
// --- カレンダー管理 ---
"list_calendars"   // getCalendarsForUser()
"get_calendar"     // getCalendarById()

// --- タスク CRUD ---
"list_tasks"       // getObjectsForCalendar() + ICS パース
"get_task"         // getObjectByUid() + ICS パース
"create_task"      // ICS 生成 + putObject()
"update_task"      // getObjectByUid() + ICS 修正 + putObject()
"complete_task"    // STATUS:COMPLETED に更新
"delete_task"      // deleteObject()

// --- 検索 ---
"search_tasks"     // getObjectsForCalendar() + ICS パースしてフィルタ
```

### 実装例

```typescript
// src/mcp/server.ts
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  getCalendarsForUser,
  getObjectsForCalendar,
  getObjectByUid,
  putObject,
  deleteObject,
} from "../caldav/storage.js";

export function createMcpServer(db: D1Database, userId: string) {
  const server = new McpServer({
    name: "hono-caldav-mcp",
    version: "1.0.0",
  });

  server.registerTool("list_calendars", {
    description: "ユーザーの全カレンダーを一覧表示",
  }, async () => {
    const calendars = await getCalendarsForUser(db, userId);
    return {
      content: [{
        type: "text",
        text: JSON.stringify(calendars.map(c => ({
          id: c.id, name: c.name, componentType: c.componentType,
        })), null, 2),
      }],
    };
  });

  server.registerTool("list_tasks", {
    description: "指定カレンダーの全タスクを一覧表示",
    inputSchema: {
      calendarId: z.number().describe("カレンダーID"),
    },
  }, async ({ calendarId }) => {
    const objects = await getObjectsForCalendar(db, calendarId);
    const tasks = objects.map(o => ({
      uid: o.uid,
      summary: o.icsData.match(/SUMMARY:(.+)/)?.[1] ?? "Untitled",
      status: o.icsData.match(/STATUS:(.+)/)?.[1] ?? "NEEDS-ACTION",
      due: o.icsData.match(/DUE[^:]*:(.+)/)?.[1] ?? null,
    }));
    return { content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }] };
  });

  server.registerTool("create_task", {
    description: "新しい VTODO タスクを作成",
    inputSchema: {
      calendarId: z.number(),
      summary: z.string().describe("タスクのタイトル"),
      due: z.string().optional().describe("期限 (YYYYMMDD or YYYYMMDDTHHmmss)"),
      priority: z.number().min(0).max(9).optional(),
      description: z.string().optional(),
    },
  }, async ({ calendarId, summary, due, priority, description }) => {
    const uid = crypto.randomUUID();
    const now = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
    let ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//hono-caldav//MCP//EN",
      "BEGIN:VTODO",
      `UID:${uid}`,
      `DTSTAMP:${now}`,
      `CREATED:${now}`,
      `SUMMARY:${summary}`,
      "STATUS:NEEDS-ACTION",
    ];
    if (due) ics.push(`DUE:${due}`);
    if (priority !== undefined) ics.push(`PRIORITY:${priority}`);
    if (description) ics.push(`DESCRIPTION:${description}`);
    ics.push("END:VTODO", "END:VCALENDAR");

    await putObject(db, calendarId, uid, ics.join("\r\n") + "\r\n");
    return { content: [{ type: "text", text: `タスク "${summary}" を作成 (UID: ${uid})` }] };
  });

  server.registerTool("complete_task", {
    description: "タスクを完了にする",
    inputSchema: {
      calendarId: z.number(),
      uid: z.string(),
    },
  }, async ({ calendarId, uid }) => {
    const obj = await getObjectByUid(db, calendarId, uid);
    if (!obj) return { content: [{ type: "text", text: "タスクが見つかりません" }] };

    const now = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
    let ics = obj.icsData.replace(/STATUS:.+\r?\n/, `STATUS:COMPLETED\r\n`);
    if (!ics.includes("COMPLETED:")) {
      ics = ics.replace("END:VTODO", `COMPLETED:${now}\r\nEND:VTODO`);
    }
    await putObject(db, calendarId, uid, ics);
    return { content: [{ type: "text", text: `タスク ${uid} を完了にしました` }] };
  });

  server.registerTool("delete_task", {
    description: "タスクを削除",
    inputSchema: {
      calendarId: z.number(),
      uid: z.string(),
    },
  }, async ({ calendarId, uid }) => {
    const deleted = await deleteObject(db, calendarId, uid);
    return {
      content: [{
        type: "text",
        text: deleted ? `タスク ${uid} を削除しました` : "タスクが見つかりません",
      }],
    };
  });

  return server;
}
```

### Hono アプリへの統合

```typescript
// src/index.ts に追加
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { createMcpServer } from "./mcp/server.js";

app.all("/mcp", async (c) => {
  // Bearer token 認証
  const auth = c.req.header("Authorization");
  if (!auth?.startsWith("Bearer ") || auth.slice(7) !== c.env.MCP_TOKEN) {
    return c.text("Unauthorized", 401);
  }

  const userId = "default"; // Phase 1 でマルチユーザー対応後は session から取得
  const server = createMcpServer(c.env.DB, userId);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // ステートレス
  });
  await server.connect(transport);

  let parsedBody: unknown;
  if (c.req.header("content-type")?.includes("application/json")) {
    parsedBody = await c.req.raw.clone().json();
  }

  return transport.handleRequest(c.req.raw, { parsedBody });
});
```

---

## 4. AI タスク管理

### Workers AI vs 外部 LLM

| 基準 | Workers AI | Gemini Flash |
|---|---|---|
| レイテンシ | 低 (同一ネットワーク) | 中 (API コール) |
| コスト | $0.35/M input tokens (Gemma 3 12B) | 無料枠あり |
| Function Calling | `@cloudflare/ai-utils` runWithTools | OpenAI compatible |
| API Key | 不要 (binding) | Secret に保存 |
| セットアップ | wrangler.jsonc に `[ai]` 追加 | API key 設定 |

**推奨**: Workers AI (Gemma 3 12B) をまず試す。精度不十分なら Gemini Flash にフォールバック。

### Workers AI Function Calling

```typescript
import { runWithTools } from "@cloudflare/ai-utils";

// Scheduled Worker での Gmail → タスク抽出
export default {
  async scheduled(controller, env, ctx) {
    const emails = await fetchNewEmails(env);

    for (const email of emails) {
      await runWithTools(env.AI, "@cf/google/gemma-3-12b-it", {
        messages: [
          {
            role: "system",
            content: `メールからタスクを抽出し、create_task ツールで登録してください。`,
          },
          { role: "user", content: `件名: ${email.subject}\n本文: ${email.body}` },
        ],
        tools: [
          {
            name: "create_task",
            description: "タスクを作成",
            parameters: {
              type: "object",
              properties: {
                summary: { type: "string" },
                due: { type: "string" },
                priority: { type: "number" },
              },
              required: ["summary"],
            },
            function: async ({ summary, due, priority }) => {
              await createTaskFromAI(env.DB, calendarId, { summary, due, priority });
              return `Created: ${summary}`;
            },
          },
        ],
      });
    }
  },
};
```

### Gmail → タスク抽出パイプライン

```
Gmail API --polling (5min cron)--> Scheduled Worker
  → メール取得
  → Workers AI で分析 (function calling)
    → タスク抽出 → VTODO ICS 生成
  → D1 に保存 (storage.ts)
  → iOS リマインダーが次回 sync で取得
```

Cron 設定:
```jsonc
// wrangler.jsonc
{ "triggers": { "crons": ["*/5 * * * *"] } }
```

### chrono-node の Workers 互換性

純粋 JS のため Workers で動作する。ただし Workers AI の function calling を使えば LLM が日時を直接パースするので不要になる可能性が高い。

### 自然言語 CRUD の3アプローチ

| アプローチ | 仕組み | ユースケース |
|---|---|---|
| **MCP tools** | Claude/Cursor が MCP 経由で tool_use | デスクトップ AI からの直接操作 |
| **Workers AI + function calling** | Worker 内で LLM → tool → D1 | Cron でのメール処理 |
| **REST API** | POST /api/tasks/natural に自然言語送信 | カスタム UI、ショートカット |

**推奨: 3つ全部実装。** それぞれ異なるユースケースに対応。

---

## 5. MCP App

### Remote MCP Server

Claude Desktop / Cursor / Claude Code から URL で接続:

```json
// claude_desktop_config.json
{
  "mcpServers": {
    "caldav-tasks": {
      "url": "https://caldav.your-domain.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_TOKEN"
      }
    }
  }
}
```

### ユーザー体験

```
ユーザー: 「明日の午前10時に歯医者の予約をリマインダーに追加して」

Claude: [MCP tool: create_task]
  calendarId: 1, summary: "歯医者の予約", due: "20260308T100000"

→ D1 に VTODO 保存
→ iOS リマインダーが次回 sync で自動取得
→ iPhone にリマインダー通知
```

---

## 6. 実装ロードマップ

### Phase 3a: MCP Server 基本

1. `bun add @modelcontextprotocol/server zod`
2. `src/mcp/server.ts` — MCP ツール定義
3. `src/index.ts` — `/mcp` エンドポイント追加
4. Bearer token 認証
5. Claude Desktop / Cursor から接続テスト

### Phase 3b: Workers AI

1. wrangler.jsonc に `"ai": { "binding": "AI" }` 追加
2. search_tasks ツール (ICS パースしてフィルタ)
3. 自然言語 → VTODO 変換エンドポイント

### Phase 3c: Gmail + Google Calendar 連携

1. Google OAuth スコープ拡張 (gmail.readonly, calendar.readonly, calendar.events)
2. Scheduled Workers (Cron Trigger)
3. Gmail API polling
4. メール → タスク抽出パイプライン
5. Google Calendar free/busy 問い合わせ

### Phase 3d: OAuth 認証

1. workers-oauth-provider 統合
2. マルチユーザー MCP 対応

## 依存追加

```bash
bun add @modelcontextprotocol/server zod
```

### wrangler.jsonc 追加

```jsonc
{
  "ai": { "binding": "AI" },
  "triggers": { "crons": ["*/5 * * * *"] }
}
```
