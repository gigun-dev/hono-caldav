# Changelog — hono-caldav

## Phase 1: Authentication Foundation + Multiuser (`1be867a`)

**16 commits, +6,508 lines, 42 files changed**

### Features
- better-auth + D1 adapter + Google OAuth integration
- App Password system (PBKDF2 100k iterations, 16-byte salt)
- CalDAV Basic Auth via App Password (legacy env fallback)
- Session-based auth guard for web pages
- Login/Dashboard/Setup pages (Hono JSX)
- iOS mobileconfig dynamic generation (unsigned)

### Files Added
- `src/auth/auth.ts` — better-auth factory
- `src/auth/app-password.ts` — App Password CRUD
- `src/middleware/auth-guard.ts` — Session middleware
- `src/pages/login.tsx`, `dashboard.tsx`, `setup.tsx`
- `migrations/0003_auth.sql` — user, session, account, verification, app_passwords

---

## Phase 2: CalDAV Server Maturation (`9ed37e6`)

### Features
- mobileconfig endpoint (`/setup/ios`)
- Cross-platform setup guide (`/setup`)
- DAV header unification
- PUT update → 204 No Content
- calendar-user-address-set in Principal response

### Files Added
- `src/setup/mobileconfig.ts`

---

## Phase 3a: MCP Server (`ecb1385`)

### Features
- JSON-RPC MCP handler (Streamable HTTP)
- 10 tools: list_calendars, list/get/create/update/complete/delete_task, search_tasks, poll_gmail, check_calendar_availability
- Bearer token authentication
- Direct storage.ts access (no CalDAV XML overhead)

### Files Added
- `src/mcp/handler.ts`

---

## Phase 3b: Workers AI Natural Language CRUD (`b4af9ba`)

### Features
- `@cf/meta/llama-3.1-8b-instruct` integration
- Intent parsing: create, complete, delete, update, list, search
- VTODO ICS generation from AI-parsed JSON
- Temperature: 0, input cap: 1000 chars
- ICS value sanitization (CRLF, semicolons, commas)

### Files Added
- `src/ai/natural-language.ts`

### Files Removed
- `src/mcp/server.ts` (ajv incompatible with workerd)

---

## Phase 3c: Gmail + Google Calendar Integration (`29f0d9b`)

### Features
- Gmail API client (fetch/parse recent emails)
- Google Calendar API (free/busy, event listing)
- Email → AI → VTODO pipeline
- OAuth token refresh flow
- Scheduled Worker (cron `*/5 * * * *`)

### Files Added
- `src/integrations/gmail.ts`, `google-auth.ts`, `google-calendar.ts`, `gmail-worker.ts`
- `migrations/0007_gmail_sync.sql`

---

## Phase 4: iTIP/iMIP Scheduling (`c93d588`, `fb5afc7`)

### Features
- SaaS as Organizer model
- iTIP REQUEST/REPLY/COUNTER generation/parsing
- Resend API for iMIP email transport
- Cloudflare Email Worker for iMIP receive (postal-mime)
- COUNTER auto-ACCEPT with SEQUENCE increment
- DECLINE feedback tracking
- PARTSTAT validation whitelist

### Files Added
- `src/scheduling/api.ts`, `itip.ts`, `storage.ts`, `email-sender.ts`, `email-worker.ts`
- `migrations/0004_scheduling.sql`, `0005_feedback.sql`, `0006_attendee_unique.sql`

---

## Phase 5a: CalDAV RFC Complete Compliance (`6bbf526`..`8377f92`)

### Features
- Calendar-query REPORT filter engine (RFC 4791 §7.8, §9.7)
  - comp-filter: VCALENDAR > VEVENT, VCALENDAR > VTODO
  - time-range: DTSTART/DTEND/DUE/COMPLETED matching (RFC 4791 §9.9)
  - prop-filter: is-not-defined, text-match
  - text-match: contains, equals, starts-with, ends-with, negate-condition
  - Collations: i;ascii-casemap, i;unicode-casemap
- Duplicate UID rejection (409 Conflict)
- Depth:infinity explicit rejection (403 Forbidden)
- Non-ASCII content support (CJK, emoji) — verified with tests
- Calendar collection DELETE (`/dav/projects/{id}/`)
- ETag-based 304 Not Modified for GET requests
- NaN-safe date parsing in time-range filters

### Files Added
- `src/caldav/query-filter.ts` — filter engine

### Security Fixes
- deleteCalendar() ownership verification (userId parameter)
- parseIcsDate() NaN validation

---

## Phase 5b: MCP OAuth

### Features
- Authorization Code + PKCE flow for MCP authentication
- D1-based token/client storage (Durable Objects 不要)
- `/.well-known/oauth-authorization-server` metadata endpoint
- `/mcp/authorize`, `/mcp/token`, `/mcp/callback` endpoints
- Legacy Bearer token 互換 (既存クライアント対応)

### Files Added
- `src/mcp/oauth.ts` — OAuth provider implementation
- `migrations/0010_mcp_oauth.sql` — OAuth clients/tokens tables

---

## Phase 5c: RRULE Recurring Events (`5369ee0`)

### Features
- RRULE expansion in time-range queries
- Conservative approach: events with RRULE checked against occurrence expansion
- Expansion limit for infinite recurrence

---

## Phase 6b: Monitoring & Health (`ca8775c`)

### Features
- `/health` endpoint with D1 connectivity check
- Structured JSON logging (requestId, durationMs, userAgent)
- Request/response logging gated by DEBUG env var

---

## Phase 6c: Tier Limits & Billing Skeleton

### Features
- `user_tiers` テーブル (tier: free/pro, stripe_customer_id, stripe_subscription_id)
- Free tier 制限: 3 calendars, 100 objects per calendar
- Pro tier: unlimited calendars & objects
- CalDAV 507 Insufficient Storage レスポンス (制限超過時)
- Stripe checkout skeleton (セッション作成エンドポイント)

### Files Added
- `src/billing/tiers.ts` — Tier enforcement logic
- `src/billing/stripe.ts` — Stripe checkout skeleton
- `migrations/0012_user_tiers.sql` — user_tiers table
- `test/tier-limits.test.ts` — 15 tests

---

## Phase 6a: Performance

### Features
- Per-user レートリミット (sliding window)
- Attendee バッチ INSERT 最適化
- updatePartstat クエリ最適化
- D1 インデックス追加 (calendar_objects, calendarchanges 複合インデックス)

### Files Added
- `src/middleware/rate-limit.ts` — Rate limiting middleware
- `migrations/0011_indexes.sql` — Performance indexes

---

## Phase 7b: Webhook Notifications

### Features
- Webhook registration API (CRUD)
- HMAC-SHA256 request signing
- Event types: task.created, task.updated, task.completed, task.deleted
- Per-user webhook isolation

### Files Added
- `src/webhooks/notify.ts` — Webhook notification system
- `migrations/0008_webhooks.sql` — Webhook table

---

## Phase 7c: Calendar Sharing

### Features
- Calendar sharing API (share/list/revoke)
- Per-user shared calendar listing
- Ownership verification (IDOR prevention)
- UNIQUE constraint for duplicate share prevention

### Files Added
- `src/sharing/api.ts` — Sharing CRUD
- `migrations/0009_calendar_shares.sql` — calendar_shares table
- `test/sharing.test.ts` — 9 tests

---

## Security Hardening (across multiple commits)

- PBKDF2 password hashing (replaced SHA-256)
- Timing-safe credential comparison
- ICS injection prevention (RFC 5545 escaping)
- MCP cross-user isolation checks
- ReDoS prevention (line-based ATTENDEE parsing)
- Debug log gating (DEBUG=true env var)
- CSRF protection (trustedOrigins)
- Calendar ownership validation (IDOR prevention)
- sync-token format validation
- URIError safe decodeURIComponent

---

## Test Coverage

| File | Tests | Coverage Area |
|------|-------|---------------|
| caldav.test.ts | 76 | CalDAV CRUD, sync, ETag, 304, Depth:infinity, non-ASCII, calendar delete, duplicate UID, edge cases |
| query-filter.test.ts | 39 | Calendar-query filter parsing, comp/prop/time-range/text-match, RRULE, edge cases |
| scheduling.test.ts | 28 | iTIP, attendee storage, feedback, API security |
| xml.test.ts | 23 | XML prop filter, depth header, collection props |
| ai.test.ts | 21 | AI response parsing, action execution |
| mcp.test.ts | 20 | MCP tools, cross-user isolation, batch |
| integrations.test.ts | 19 | Gmail/Calendar API parsing |
| ical.test.ts | 15 | UID extraction, component validation |
| auth.test.ts | 11 | App Password PBKDF2, CalDAV auth |
| mobileconfig.test.ts | 9 | Plist structure, XSS escaping |
| natural-language-e2e.test.ts | 9 | ICS escaping, edge cases |
| webhooks.test.ts | TBD | Webhook CRUD, HMAC signing, event delivery |
| sharing.test.ts | 9 | Calendar sharing API, ownership, IDOR, duplicate prevention |
| mcp-oauth.test.ts | 21 | MCP OAuth flow, PKCE, token management, well-known metadata |
| rate-limit.test.ts | 8 | Rate limiting, sliding window, per-user isolation |
| email-sender.test.ts | 4 | Resend API mock |
| tier-limits.test.ts | 15 | Tier enforcement, Free/Pro limits, 507 response, Stripe checkout |
| **Total** | **364+** | **18 files** |
