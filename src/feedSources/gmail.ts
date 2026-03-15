
import { createGmailServiceForUser, type GmailUserCredentials } from '../services/gmail.js'
import { getLastHistoryIdForUser, setLastHistoryIdForUser } from '../store.js'
import type { FeedItem } from '../types.js'
import type { FeedSource } from './types.js'

// -------- ユーザー定義 --------

export interface GmailUserRecord {
  userId: string
  credentials: GmailUserCredentials
}

/**
 * Gmail ユーザー一覧を返す（モック実装）。
 * env の GOOGLE_REFRESH_TOKEN / GMAIL_USER_EMAIL のみで 1 ユーザー分を返す。
 * 複数ユーザーまたは D1 利用時は getGmailUsersFromAccountTable を使う。
 */
export function getMockUsers(env: CloudflareBindings): GmailUserRecord[] {
  const refreshToken = env.GOOGLE_REFRESH_TOKEN
  if (!refreshToken) return []

  const email = env.GMAIL_USER_EMAIL ?? 'me'
  return [
    {
      userId: email,
      credentials: {
        refreshToken,
        email,
      },
    },
  ]
}

// -------- D1 account テーブルから取得（Phase 1 / Workers 用） --------

/** D1 account テーブルの Gmail 用行。userId は user.id への FK。 */
export interface AccountRow {
  userId: string
  refreshToken: string | null
  providerId?: string
  /** Gmail API の userId（メールアドレス）。未設定なら 'me' として扱う。 */
  email?: string | null
}

/**
 * D1 の prepare().bind().all() と互換な最小インターフェース。
 * Cloudflare Workers の c.env.DB をそのまま渡せる。
 */
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): { all(): Promise<{ results: AccountRow[] }> }
  }
}

const SQL_GOOGLE_ACCOUNTS = `
  SELECT userId, refreshToken, providerId
  FROM account
  WHERE providerId = 'google' AND refreshToken IS NOT NULL
`.trim()

/**
 * D1 の account テーブルから「ユーザーID と リフレッシュトークンのペア」を取得する。
 * Cron など同一 Worker 内で DB を直接叩く想定（HTTP を経由しない）。
 *
 * - 暗号化していない場合: そのまま GmailUserRecord にマッピングする。
 * - encryptOAuthTokens: true の場合: options.decrypt で復号してから使うこと。
 *   （better-auth の AES-256-GCM 復号を BETTER_AUTH_SECRET 等で実装する。）
 *
 * @param db D1 互換オブジェクト（Workers では c.env.DB）
 * @param options.decrypt 暗号化済み refreshToken の復号関数。未指定なら平文として扱う。
 */
export async function getGmailUsersFromAccountTable(
  db: D1Like,
  options?: { decrypt?: (encrypted: string) => string | Promise<string> }
): Promise<GmailUserRecord[]> {
  const stmt = db.prepare(SQL_GOOGLE_ACCOUNTS)
  const { results } = await stmt.bind().all()
  const decrypt = options?.decrypt ?? ((s: string) => s)
  const out: GmailUserRecord[] = []

  for (const row of results) {
    if (!row.refreshToken) continue
    const refreshToken = await Promise.resolve(decrypt(row.refreshToken))
    out.push({
      userId: row.userId,
      credentials: {
        refreshToken,
        email: row.email ?? undefined,
      },
    })
  }

  return out
}

// -------- FeedSource 実装 --------

/**
 * Gmail をソースとする FeedSource 実装。
 * historyId を store で管理し、差分スレッドを FeedItem[] に変換して返す。
 * db を渡すと D1 の gmail_history_sync に保存。未指定時は historyId は永続化されない。
 * ユーザー情報（userId）は FeedItem に付与するが content には含めないため LLM には渡らない。
 */
export class GmailFeedSource implements FeedSource {
  private readonly gmail: ReturnType<typeof createGmailServiceForUser>
  private readonly db: D1Database | null

  constructor(user: GmailUserRecord, db: D1Database | null, env: CloudflareBindings) {
    this.user = user
    this.gmail = createGmailServiceForUser(user.credentials, env)
    this.db = db
  }

  private readonly user: GmailUserRecord

  get userId(): string {
    return this.user.userId
  }

  async poll(): Promise<FeedItem[]> {
    const lastHistoryId = await getLastHistoryIdForUser(this.user.userId, this.db)

    // 初回: 現在の historyId を記録して終了（差分なし）
    if (!lastHistoryId) {
      const currentId = await this.gmail.getCurrentHistoryId()
      await setLastHistoryIdForUser(this.user.userId, currentId, this.db)
      console.log(`[GmailFeedSource][${this.user.userId}] 初回: historyId=${currentId} を記録しました`)
      return []
    }

    console.log(`[GmailFeedSource][${this.user.userId}] startHistoryId=${lastHistoryId}`)
    const { threadIds, newHistoryId } = await this.gmail.pollNewThreads(lastHistoryId)
    await setLastHistoryIdForUser(this.user.userId, newHistoryId, this.db)

    if (threadIds.length === 0) {
      console.log(`[GmailFeedSource][${this.user.userId}] 新着スレッドなし`)
      return []
    }

    console.log(`[GmailFeedSource][${this.user.userId}] ${threadIds.length} スレッドを処理中...`)
    const items: FeedItem[] = []

    for (const threadId of threadIds) {
      const item = await this.gmail.fetchThreadAsFeedItem(threadId)
      if (!item) continue
      console.log(`[GmailFeedSource][${this.user.userId}] threadId=${threadId} title="${item.title}"`)
      items.push(item)
    }

    return items
  }
}
