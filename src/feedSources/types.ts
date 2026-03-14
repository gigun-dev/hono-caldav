import type { FeedItem } from '../types.js'

/**
 * コンテンツソースの共通インターフェース。
 * cron から呼ばれ、新着の FeedItem[] を返す。
 * Gmail・外部 RSS など、ソースの種類に依存しない。
 */
export interface FeedSource {
  /** このソースを所有するユーザー ID */
  readonly userId: string
  /** 新着コンテンツを取得して FeedItem[] を返す */
  poll(): Promise<FeedItem[]>
}
