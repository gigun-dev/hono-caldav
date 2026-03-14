/**
 * Workers の env 型。
 * wrangler types（cf-typegen）で worker-configuration.d.ts が生成された場合はそちらを優先してよい。
 */
/// <reference types="@cloudflare/workers-types" />

export interface CloudflareBindings {
  DB: D1Database
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  GOOGLE_REFRESH_TOKEN?: string
  GMAIL_USER_EMAIL?: string
  /** .dev.vars または Workers のシークレットで指定。cron の LLM 抽出で使用。 */
  API_KEY?: string
  OPENAI_BASE_URL?: string
  SCHEDULE_EXTRACT_MODEL?: string
}
