import type { RssItem } from '../types.js'
import { rssItemToXml } from './rss.js'

export interface WebhookPayload {
  type: 'rss-item'
  item: RssItem
  xml: string
}

/**
 * 抽出した RSS アイテムを WEBHOOK_URL に POST 送信する。
 */
export async function sendWebhook(item: RssItem): Promise<void> {
  const url = process.env.WEBHOOK_URL
  if (!url) {
    console.warn('[webhook] WEBHOOK_URL が未設定のためスキップします')
    return
  }

  const payload: WebhookPayload = {
    type: 'rss-item',
    item,
    xml: rssItemToXml(item),
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`[webhook] HTTP ${res.status}: ${body}`)
  }

  console.log(`[webhook] 送信完了 guid=${item.guid} status=${res.status}`)
}
