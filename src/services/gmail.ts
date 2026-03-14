import { google, gmail_v1 } from 'googleapis'
import type { CloudflareBindings } from '../cloudflare-bindings.js'
import type { EmailData, FeedItem } from '../types.js'
import { MailThread } from '../Task/MailThread.js'
import { mail } from '../Task/Unit.js'

function createOAuth2Client(env: CloudflareBindings) {
  const clientId = env.GOOGLE_CLIENT_ID
  const clientSecret = env.GOOGLE_CLIENT_SECRET
  const client = new google.auth.OAuth2(clientId, clientSecret)
  client.setCredentials({ refresh_token: env.GOOGLE_REFRESH_TOKEN })
  return client
}

function userId(env: CloudflareBindings) {
  return env.GMAIL_USER_EMAIL ?? 'me'
}

/**
 * Pub/Sub push で受け取った historyId を起点に追加メッセージ ID を取得する。
 */
export async function getNewMessageIds(
  startHistoryId: string,
  env: CloudflareBindings,
): Promise<string[]> {
  const auth = createOAuth2Client(env)
  const gmail = google.gmail({ version: 'v1', auth })

  const res = await gmail.users.history.list({
    userId: userId(env),
    startHistoryId,
    historyTypes: ['messageAdded'],
  })

  const historyList = res.data.history ?? []
  const ids: string[] = []

  for (const h of historyList) {
    for (const added of h.messagesAdded ?? []) {
      if (added.message?.id) ids.push(added.message.id)
    }
  }

  return [...new Set(ids)]
}

/**
 * メッセージ ID からメール内容を取得・パースする。
 */
export async function fetchMessage(
  messageId: string,
  env: CloudflareBindings,
): Promise<EmailData | null> {
  const auth = createOAuth2Client(env)
  const gmail = google.gmail({ version: 'v1', auth })

  const res = await gmail.users.messages.get({
    userId: userId(env),
    id: messageId,
    format: 'full',
  })

  const msg = res.data
  if (!msg.payload) return null

  const headers = msg.payload.headers ?? []
  const getHeader = (name: string) =>
    headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value ?? ''

  const subject = getHeader('Subject') || '(件名なし)'
  const from = getHeader('From') || ''
  const dateHeader = getHeader('Date') || ''
  const date = dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString()
  const body = extractBodyFromPart(msg.payload)

  return { messageId, subject, from, date, body }
}

/**
 * Pub/Sub push で受け取った historyId を起点にスレッド ID（重複なし）を取得する。
 */
export async function getNewThreadIds(
  startHistoryId: string,
  env: CloudflareBindings,
): Promise<string[]> {
  const auth = createOAuth2Client(env)
  const gmail = google.gmail({ version: 'v1', auth })

  const res = await gmail.users.history.list({
    userId: userId(env),
    startHistoryId,
    historyTypes: ['messageAdded'],
  })

  const threadIds = new Set<string>()
  for (const h of res.data.history ?? []) {
    for (const added of h.messagesAdded ?? []) {
      if (added.message?.threadId) threadIds.add(added.message.threadId)
    }
  }

  return [...threadIds]
}

/**
 * スレッド ID からスレッド内の全メッセージを取得し MailThread を構築する。
 * latestEmail は RSS アイテム構築用（最後のメッセージの EmailData）。
 */
export async function fetchThreadAsMailThread(
  threadId: string,
  env: CloudflareBindings,
): Promise<{ mailThread: MailThread; latestEmail: EmailData } | null> {
  const auth = createOAuth2Client(env)
  const gmail = google.gmail({ version: 'v1', auth })

  const res = await gmail.users.threads.get({
    userId: userId(env),
    id: threadId,
    format: 'full',
  })

  const messages = res.data.messages ?? []
  if (messages.length === 0) return null

  const thread = new MailThread()
  let latestEmail: EmailData | null = null

  for (const msg of messages) {
    if (!msg.payload) continue

    const headers = msg.payload.headers ?? []
    const getHeader = (name: string) =>
      headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value ?? ''

    const subject = getHeader('Subject') || '(件名なし)'
    const from = getHeader('From') || ''
    const dateHeader = getHeader('Date') || ''
    const dateIso = dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString()
    const dueDate = dateHeader ? new Date(dateHeader) : new Date()
    const body = extractBodyFromPart(msg.payload)

    thread.addMail(new mail(msg.id ?? '', subject, body, dueDate, 'todo', 'normal'))
    latestEmail = { messageId: msg.id ?? '', subject, from, date: dateIso, body }
  }

  if (!latestEmail) return null
  return { mailThread: thread, latestEmail }
}

/**
 * Gmail プロフィールから現在の historyId を取得する（初回初期化用）。
 */
export async function getCurrentHistoryId(env: CloudflareBindings): Promise<string> {
  const auth = createOAuth2Client(env)
  const gmail = google.gmail({ version: 'v1', auth })
  const res = await gmail.users.getProfile({ userId: userId(env) })
  return res.data.historyId ?? ''
}

/**
 * startHistoryId 以降の新着スレッド ID と最新 historyId を返す（cron ポーリング用）。
 */
export async function pollNewThreads(
  startHistoryId: string,
  env: CloudflareBindings,
): Promise<{ threadIds: string[]; newHistoryId: string }> {
  const auth = createOAuth2Client(env)
  const gmail = google.gmail({ version: 'v1', auth })

  const res = await gmail.users.history.list({
    userId: userId(env),
    startHistoryId,
    historyTypes: ['messageAdded'],
  })

  const newHistoryId = res.data.historyId ?? startHistoryId
  const threadIds = new Set<string>()
  for (const h of res.data.history ?? []) {
    for (const added of h.messagesAdded ?? []) {
      if (added.message?.threadId) threadIds.add(added.message.threadId)
    }
  }

  return { threadIds: [...threadIds], newHistoryId }
}

/**
 * 最近のメッセージを検索して取得する（手動トリガー用）。
 */
export async function listRecentMessages(
  query: string,
  maxResults: number,
  env: CloudflareBindings,
): Promise<EmailData[]> {
  const auth = createOAuth2Client(env)
  const gmail = google.gmail({ version: 'v1', auth })

  const listRes = await gmail.users.messages.list({
    userId: userId(env),
    q: query,
    maxResults,
  })

  const messages = listRes.data.messages ?? []
  const results: EmailData[] = []

  for (const m of messages) {
    if (!m.id) continue
    const data = await fetchMessage(m.id, env)
    if (data) results.push(data)
  }

  return results
}

// -------- マルチユーザー対応ファクトリ --------

export interface GmailUserCredentials {
  refreshToken: string
  email?: string
}

/**
 * ユーザーの credentials から Gmail API ラッパーを生成する。
 * cron ポーリングなどマルチユーザー処理で使用する。
 */
export function createGmailServiceForUser(
  credentials: GmailUserCredentials,
  env: CloudflareBindings,
) {
  const clientId = env.GOOGLE_CLIENT_ID
  const clientSecret = env.GOOGLE_CLIENT_SECRET
  const auth = new google.auth.OAuth2(clientId, clientSecret)
  auth.setCredentials({ refresh_token: credentials.refreshToken })
  const gmail = google.gmail({ version: 'v1', auth })
  const uid = credentials.email ?? 'me'

  return {
    async getCurrentHistoryId(): Promise<string> {
      const res = await gmail.users.getProfile({ userId: uid })
      return res.data.historyId ?? ''
    },

    async pollNewThreads(
      startHistoryId: string,
    ): Promise<{ threadIds: string[]; newHistoryId: string }> {
      const res = await gmail.users.history.list({
        userId: uid,
        startHistoryId,
        historyTypes: ['messageAdded'],
      })
      const newHistoryId = res.data.historyId ?? startHistoryId
      const threadIds = new Set<string>()
      for (const h of res.data.history ?? []) {
        for (const added of h.messagesAdded ?? []) {
          if (added.message?.threadId) threadIds.add(added.message.threadId)
        }
      }
      return { threadIds: [...threadIds], newHistoryId }
    },

    async fetchThreadAsMailThread(
      threadId: string,
    ): Promise<{ mailThread: MailThread; latestEmail: EmailData } | null> {
      const res = await gmail.users.threads.get({ userId: uid, id: threadId, format: 'full' })
      const messages = res.data.messages ?? []
      if (messages.length === 0) return null

      const thread = new MailThread()
      let latestEmail: EmailData | null = null

      for (const msg of messages) {
        if (!msg.payload) continue
        const headers = msg.payload.headers ?? []
        const getHeader = (name: string) =>
          headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value ?? ''
        const subject = getHeader('Subject') || '(件名なし)'
        const from = getHeader('From') || ''
        const dateHeader = getHeader('Date') || ''
        const dateIso = dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString()
        const dueDate = dateHeader ? new Date(dateHeader) : new Date()
        const body = extractBodyFromPart(msg.payload)
        thread.addMail(new mail(msg.id ?? '', subject, body, dueDate, 'todo', 'normal'))
        latestEmail = { messageId: msg.id ?? '', subject, from, date: dateIso, body }
      }

      if (!latestEmail) return null
      return { mailThread: thread, latestEmail }
    },

    async fetchThreadAsFeedItem(threadId: string): Promise<FeedItem | null> {
      const res = await gmail.users.threads.get({ userId: uid, id: threadId, format: 'full' })
      const messages = res.data.messages ?? []
      if (messages.length === 0) return null

      const thread = new MailThread()
      for (const msg of messages) {
        if (!msg.payload) continue
        const headers = msg.payload.headers ?? []
        const getHeader = (name: string) =>
          headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value ?? ''
        const subject = getHeader('Subject') || '(件名なし)'
        const from = getHeader('From') || ''
        const dateHeader = getHeader('Date') || ''
        const dueDate = dateHeader ? new Date(dateHeader) : new Date()
        const body = extractBodyFromPart(msg.payload)
        thread.addMail(new mail(msg.id ?? '', subject, body, dueDate, 'todo', 'normal', from))
      }

      if (!thread.getLatestMail()) return null
      return thread.toFeedItem(threadId, uid)
    },
  }
}

// -------- 内部ヘルパー --------

function decodeBase64Url(encoded: string): string {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(base64, 'base64').toString('utf-8')
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function extractBodyFromPart(part: gmail_v1.Schema$MessagePart): string {
  if (part.mimeType === 'text/plain' && part.body?.data) {
    return decodeBase64Url(part.body.data)
  }

  if (part.parts) {
    for (const p of part.parts) {
      if (p.mimeType === 'text/plain' && p.body?.data) {
        return decodeBase64Url(p.body.data)
      }
    }
    for (const p of part.parts) {
      if (p.mimeType === 'text/html' && p.body?.data) {
        return stripHtml(decodeBase64Url(p.body.data))
      }
    }
    for (const p of part.parts) {
      const result = extractBodyFromPart(p)
      if (result) return result
    }
  }

  if (part.mimeType === 'text/html' && part.body?.data) {
    return stripHtml(decodeBase64Url(part.body.data))
  }

  return ''
}
