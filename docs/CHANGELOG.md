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
| caldav.test.ts | 57 | CalDAV CRUD, sync, ETag, edge cases |
| scheduling.test.ts | 28 | iTIP, attendee storage, feedback, API security |
| xml.test.ts | 23 | XML prop filter, depth header, collection props |
| ai.test.ts | 21 | AI response parsing, action execution |
| mcp.test.ts | 20 | MCP tools, cross-user isolation, batch |
| integrations.test.ts | 19 | Gmail/Calendar API parsing |
| ical.test.ts | 15 | UID extraction, component validation |
| auth.test.ts | 11 | App Password PBKDF2, CalDAV auth |
| mobileconfig.test.ts | 9 | Plist structure, XSS escaping |
| natural-language-e2e.test.ts | 9 | ICS escaping, edge cases |
| email-sender.test.ts | 4 | Resend API mock |
| **Total** | **216** | |
