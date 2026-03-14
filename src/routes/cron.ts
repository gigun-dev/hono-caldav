import { Hono } from 'hono'
import type { CloudflareBindings } from '../cloudflare-bindings.js'
import { ScheduleExtractor } from '../Task/openAI.js'
import {
  GmailFeedSource,
  getGmailUsersFromAccountTable,
  getMockUsers,
} from '../feedSources/gmail.js'
import type { FeedSource } from '../feedSources/types.js'

const app = new Hono<{ Bindings: CloudflareBindings }>()

function createExtractor(env: CloudflareBindings) {
  return new ScheduleExtractor({
    apiKey: env.API_KEY ?? env.GROQ_API_KEY ?? env.OPENAI_API_KEY ?? '',
    baseURL: env.OPENAI_BASE_URL ?? 'https://api.groq.com/openai/v1',
    model: env.SCHEDULE_EXTRACT_MODEL ?? 'llama-3.1-8b-instant',
  })
}

/**
 * 使用するソース一覧。env.DB があれば D1 の account から取得、なければ環境変数で Gmail 1 ユーザー。
 * GmailFeedSource には env.DB を渡し、historyId を D1 の gmail_history_sync に保存する。
 */
async function getSources(env: CloudflareBindings): Promise<FeedSource[]> {
  const gmailUsers = env.DB
    ? await getGmailUsersFromAccountTable(env.DB)
    : getMockUsers(env)
  return gmailUsers.map(u => new GmailFeedSource(u, env.DB, env))
}

/**
 * GET /cron/poll
 * 全ソースをポーリングし、新着 FeedItem を LLM で処理する。
 * FeedItem.userId でユーザーとタスクが紐づく（userId は LLM に送らない）。
 */
app.get('/poll', async (c) => {
  const sources = await getSources(c.env)
  if (sources.length === 0) {
    return c.json({ ok: false, error: 'ソースが見つかりません' }, 500)
  }

  const extractor = createExtractor(c.env)
  const results: Record<string, object> = {}

  for (const source of sources) {
    try {
      const feedItems = await source.poll()
      let processed = 0

      for (const item of feedItems) {
        console.log(`\n[cron/poll][${item.userId}] title="${item.title}"`)
        console.log('--- content ---\n', item.content)
        console.log('--- extractFromFeed 呼び出し中 ---')

        const extracted = await extractor.extractFromFeed(item)
        console.log('--- extractFromFeed 結果 ---\n', extracted ?? '(null)')

        // 抽出したタスクをコンソール出力
        if (extracted) {
          try {
            const parsed = JSON.parse(extracted) as { tasks?: Array<{ date?: string; title?: string; location?: string; description?: string }> }
            const tasks = parsed?.tasks ?? []
            console.log(`[cron/poll][${item.userId}] 抽出タスク数: ${tasks.length}`)
            tasks.forEach((t, i) => {
              console.log(`  タスク ${i + 1}:`, {
                date: t.date ?? '(なし)',
                title: t.title ?? '(なし)',
                location: t.location ?? null,
                description: t.description ? (t.description.length > 80 ? t.description.slice(0, 80) + '...' : t.description) : null,
              })
            })
          } catch {
            // JSON パース失敗時は生文字列のまま表示済み
          }
        }
        // TODO: extracted + item.userId → RssItem 変換 → sendWebhook
        processed++
      }

      results[source.userId] = { processed }
    } catch (err) {
      console.error(`[cron/poll][${source.userId}] エラー:`, err)
      results[source.userId] = { error: String(err) }
    }
  }

  return c.json({ ok: true, results })
})

export default app
