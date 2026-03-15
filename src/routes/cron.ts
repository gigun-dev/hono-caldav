import { Hono } from 'hono'

import type { ScheduleExtractionResult } from '../types.js'
import {
  ensureDefaultCalendarsForUser,
  getDefaultCalendarsForUser,
  putObject,
} from '../caldav/storage.js'
import {
  extractedEventToVeventIcs,
  extractedTaskToVtodoIcs,
} from '../caldav/ics-from-extraction.js'
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
      if (c.env.DB) {
        await ensureDefaultCalendarsForUser(c.env.DB, source.userId)
      }
      const feedItems = await source.poll()
      let processed = 0

      for (const item of feedItems) {
        console.log(`\n[cron/poll][${item.userId}] title="${item.title}"`)
        console.log('--- content ---\n', item.content)
        console.log('--- extractFromFeed 呼び出し中 ---')

        const extracted = await extractor.extractFromFeed(item)
        console.log('--- extractFromFeed 結果 ---\n', extracted ?? '(null)')

        // 抽出した予定・タスクを分別してコンソール出力し、user_default_calendars のカレンダーに保存
        if (extracted) {
          try {
            const parsed = JSON.parse(extracted) as ScheduleExtractionResult
            const events = parsed?.events ?? []
            const tasks = parsed?.tasks ?? []
            console.log(`[cron/poll][${item.userId}] 抽出: 予定 ${events.length} 件, タスク ${tasks.length} 件`)
            events.forEach((e, i) => {
              console.log(`  予定 ${i + 1}:`, {
                date: e.date ?? '(なし)',
                time: e.startTime && e.endTime ? `${e.startTime}-${e.endTime}` : e.startTime ?? null,
                title: e.title ?? '(なし)',
                location: e.location ?? null,
                description: e.description ? (e.description.length > 80 ? e.description.slice(0, 80) + '...' : e.description) : null,
              })
            })
            tasks.forEach((t, i) => {
              console.log(`  タスク ${i + 1}:`, {
                date: t.date ?? '(なし)',
                title: t.title ?? '(なし)',
                location: t.location ?? null,
                description: t.description ? (t.description.length > 80 ? t.description.slice(0, 80) + '...' : t.description) : null,
              })
            })

            // user_default_calendars のカレンダーに VTODO/VEVENT として保存
            if (c.env.DB) {
              let defaults = await getDefaultCalendarsForUser(c.env.DB, item.userId)
              if (!defaults) {
                try {
                  defaults = await ensureDefaultCalendarsForUser(c.env.DB, item.userId)
                } catch (err) {
                  console.error(`[cron/poll][${item.userId}] デフォルトカレンダー作成失敗:`, err)
                }
              }
              if (defaults) {
                for (let i = 0; i < tasks.length; i++) {
                  const uid = `extracted-${item.id}-task-${i}`
                  try {
                    const ics = extractedTaskToVtodoIcs(tasks[i], uid)
                    await putObject(c.env.DB, defaults.taskListCalendarId, uid, ics)
                  } catch (err) {
                    console.error(`[cron/poll][${item.userId}] タスク保存失敗 (${uid}):`, err)
                  }
                }
                for (let i = 0; i < events.length; i++) {
                  const uid = `extracted-${item.id}-event-${i}`
                  try {
                    const ics = extractedEventToVeventIcs(events[i], uid)
                    await putObject(c.env.DB, defaults.eventCalendarId, uid, ics)
                  } catch (err) {
                    console.error(`[cron/poll][${item.userId}] 予定保存失敗 (${uid}):`, err)
                  }
                }
              } else {
                console.warn(`[cron/poll][${item.userId}] user_default_calendars が見つかりません`)
              }
            }
          } catch {
            // JSON パース失敗時は生文字列のまま表示済み
          }
        }
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
