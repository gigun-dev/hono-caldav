import { Hono } from 'hono'
import type { CloudflareBindings } from '../cloudflare-bindings.js'
import { listRecentMessages } from '../services/gmail.js'
import { extractSchedule } from '../services/openai.js'
import { buildRssItem } from '../services/rss.js'
import { sendWebhook } from '../services/webhook.js'

const app = new Hono<{ Bindings: CloudflareBindings }>()

/**
 * POST /gmail/fetch
 * 手動で Gmail を取得し、予定を抽出して webhook に送信する。
 *
 * クエリパラメータ:
 *   maxResults  取得件数 (デフォルト: 5)
 *   q           Gmail 検索クエリ (デフォルト: in:inbox)
 *   scheduleOnly true の場合、予定が含まれるメールのみ webhook 送信 (デフォルト: true)
 */
app.post('/fetch', async (c) => {
  const maxResults = Math.min(Number(c.req.query('maxResults') ?? 5), 20)
  const q = c.req.query('q') ?? 'in:inbox'
  const scheduleOnly = c.req.query('scheduleOnly') !== 'false'

  console.log(`[gmail/fetch] q="${q}" maxResults=${maxResults} scheduleOnly=${scheduleOnly}`)

  const emails = await listRecentMessages(q, maxResults, c.env)
  console.log(`[gmail/fetch] ${emails.length} 件取得`)

  const results: Array<{
    messageId: string
    subject: string
    hasSchedule: boolean
    eventsCount: number
    webhookSent: boolean
  }> = []

  for (const email of emails) {
    const extraction = await extractSchedule(email.subject, email.body)

    let webhookSent = false
    if (extraction.hasSchedule || !scheduleOnly) {
      const rssItem = buildRssItem(email, extraction)
      await sendWebhook(rssItem)
      webhookSent = true
    }

    results.push({
      messageId: email.messageId,
      subject: email.subject,
      hasSchedule: extraction.hasSchedule,
      eventsCount: extraction.events.length,
      webhookSent,
    })

    console.log(
      `[gmail/fetch] ${email.subject} → hasSchedule=${extraction.hasSchedule} sent=${webhookSent}`
    )
  }

  return c.json({
    ok: true,
    fetched: emails.length,
    webhookSent: results.filter(r => r.webhookSent).length,
    results,
  })
})

export default app
