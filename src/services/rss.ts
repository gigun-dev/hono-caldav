import type { EmailData, ExtractionResult, RssItem } from '../types.js'

/**
 * メールデータと抽出結果から RSS アイテムを構築する。
 */
export function buildRssItem(email: EmailData, extraction: ExtractionResult): RssItem {
  const firstEvent = extraction.events[0]

  const title = firstEvent
    ? `[予定] ${firstEvent.title}`
    : `[メール] ${email.subject}`

  const description = extraction.hasSchedule
    ? extraction.events
        .map(e => {
          const parts = [`📅 ${e.date}${e.time ? ` ${e.time}` : ''}${e.endTime ? `〜${e.endTime}` : ''}`]
          if (e.location) parts.push(`📍 ${e.location}`)
          parts.push(e.description)
          return parts.join('\n')
        })
        .join('\n\n')
    : email.body.slice(0, 500)

  return {
    guid: `gmail-${email.messageId}`,
    title,
    description,
    pubDate: new Date(email.date).toUTCString(),
    source: {
      emailFrom: email.from,
      emailSubject: email.subject,
      emailDate: email.date,
    },
    events: extraction.events,
  }
}

/**
 * RssItem を RSS 2.0 の <item> XML 文字列に変換する。
 */
export function rssItemToXml(item: RssItem): string {
  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  const eventsXml = item.events
    .map(e => {
      const parts = [
        `<event>`,
        `  <title>${escape(e.title)}</title>`,
        `  <date>${escape(e.date)}</date>`,
        e.time ? `  <time>${escape(e.time)}</time>` : '',
        e.endTime ? `  <endTime>${escape(e.endTime)}</endTime>` : '',
        e.location ? `  <location>${escape(e.location)}</location>` : '',
        `  <description>${escape(e.description)}</description>`,
        `</event>`,
      ].filter(Boolean)
      return parts.join('\n')
    })
    .join('\n')

  return [
    `<item>`,
    `  <title>${escape(item.title)}</title>`,
    `  <description>${escape(item.description)}</description>`,
    `  <pubDate>${escape(item.pubDate)}</pubDate>`,
    `  <guid isPermaLink="false">${escape(item.guid)}</guid>`,
    `  <source emailFrom="${escape(item.source.emailFrom)}">${escape(item.source.emailSubject)}</source>`,
    eventsXml ? `  <events>\n${eventsXml}\n  </events>` : '',
    `</item>`,
  ].filter(Boolean).join('\n')
}
