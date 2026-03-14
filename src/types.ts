import type { CaldavUser } from "./auth/auth.js";

export type AppBindings = {
	Bindings: CloudflareBindings;
	Variables: {
		user: CaldavUser;
	};
};
export interface ExtractedEvent {
	title: string
	date: string        // YYYY-MM-DD
	time?: string       // HH:mm
	endTime?: string    // HH:mm
	location?: string
	description: string
  }
  
  export interface ExtractionResult {
	hasSchedule: boolean
	events: ExtractedEvent[]
  }
  
  export interface EmailData {
	messageId: string
	subject: string
	from: string
	date: string        // ISO 8601
	body: string
  }
  
  /**
   * ソース非依存のコンテンツ抽象。
   * メール・外部 RSS・その他どのソースも FeedItem に変換してから LLM に渡す。
   */
  export interface FeedItem {
	id: string
	userId: string     // 所有ユーザー ID（LLM には送らない）
	title: string
	content: string    // LLM へ渡す本文（MailThread.toPromptString() 相当）
	from: string
	date: string       // ISO 8601
	sourceType: string // 'email' | 'rss' | ...
  }
  
  export interface RssItem {
	guid: string
	title: string
	description: string
	pubDate: string     // RFC 2822
	source: {
	  emailFrom: string
	  emailSubject: string
	  emailDate: string
	}
	events: ExtractedEvent[]
  }
  