import { Hono } from "hono";

import { createAuth } from "./auth/auth.js";
import {
	createAppPassword,
	listAppPasswords,
	revokeAppPassword,
} from "./auth/app-password.js";
import { registerCaldavRoutes } from "./caldav/handlers.js";
import { getCalendarById } from "./caldav/storage.js";
import { authGuard } from "./middleware/auth-guard.js";
import { LoginPage } from "./pages/login.js";
import { DashboardPage } from "./pages/dashboard.js";
import { SetupPage } from "./pages/setup.js";
import { generateMobileconfig } from "./setup/mobileconfig.js";
import { handleMcpRequest } from "./mcp/handler.js";
import { processNaturalLanguage } from "./ai/natural-language.js";
import {
	createScheduledEvent,
	processReply,
	processCounter,
	getEventAttendees,
} from "./scheduling/api.js";
import { handleEmail } from "./scheduling/email-worker.js";
import { getValidAccessToken } from "./integrations/google-auth.js";
import { pollGmailForTasks } from "./integrations/gmail-worker.js";
import { getCalendarsForUser } from "./caldav/storage.js";
import {
	createWebhook,
	listWebhooks,
	deleteWebhook,
} from "./webhooks/notify.js";
import {
	shareCalendar,
	listShares,
	revokeShare,
	getSharedCalendars,
} from "./sharing/api.js";

function timingSafeEqualStr(a: string, b: string): boolean {
	const encoder = new TextEncoder();
	const aBuf = encoder.encode(a);
	const bBuf = encoder.encode(b);
	if (aBuf.length !== bBuf.length) return false;
	let result = 0;
	for (let i = 0; i < aBuf.length; i++) {
		result |= aBuf[i]! ^ bBuf[i]!;
	}
	return result === 0;
}

const app = new Hono<{ Bindings: CloudflareBindings }>();

// Structured logging middleware for CalDAV (gated by DEBUG env var)
app.use("/dav/*", async (c, next) => {
	const debug = (c.env as Record<string, string>).DEBUG === "true";
	const requestId = crypto.randomUUID().slice(0, 8);
	const startTime = Date.now();
	if (debug) {
		const logEntry: Record<string, unknown> = {
			requestId,
			method: c.req.method,
			path: c.req.path,
			depth: c.req.header("depth") ?? null,
			contentType: c.req.header("content-type") ?? null,
			userAgent: c.req.header("user-agent") ?? null,
		};
		if (["PUT", "PROPPATCH", "REPORT", "MKCOL"].includes(c.req.method)) {
			const body = await c.req.raw.clone().text();
			logEntry.bodyLength = body.length;
			logEntry.bodyPreview = body.slice(0, 300);
		}
		console.log(JSON.stringify({ level: "debug", event: "request", ...logEntry }));
	}
	await next();
	const duration = Date.now() - startTime;
	if (debug) {
		console.log(JSON.stringify({
			level: "debug",
			event: "response",
			requestId,
			method: c.req.method,
			path: c.req.path,
			status: c.res.status,
			durationMs: duration,
		}));
	}
});

// --- better-auth routes ---
app.on(["POST", "GET"], "/api/auth/**", (c) => {
	const auth = createAuth(c.env);
	return auth.handler(c.req.raw);
});

// --- Public pages ---
app.get("/", (c) => c.redirect("/login"));
app.get("/login", (c) => {
	return c.html(<LoginPage />);
});

// --- Protected pages ---
app.get("/dashboard", authGuard, async (c) => {
	const user = c.get("user");
	const appPasswords = await listAppPasswords(c.env.DB, user.id);
	return c.html(
		<DashboardPage
			userName={user.name}
			userEmail={user.email}
			appPasswords={appPasswords}
		/>,
	);
});

// --- App Password API ---
app.post("/api/app-passwords", authGuard, async (c) => {
	const user = c.get("user");
	const body = await c.req.parseBody();
	const name = String(body.name || "").trim();
	if (!name) {
		return c.redirect("/dashboard");
	}
	const { appPassword, plainPassword } = await createAppPassword(
		c.env.DB,
		user.id,
		name,
	);
	const appPasswords = await listAppPasswords(c.env.DB, user.id);
	return c.html(
		<DashboardPage
			userName={user.name}
			userEmail={user.email}
			appPasswords={appPasswords}
			newPassword={plainPassword}
		/>,
	);
});

app.post("/api/app-passwords/:id/revoke", authGuard, async (c) => {
	const user = c.get("user");
	await revokeAppPassword(c.env.DB, user.id, c.req.param("id"));
	return c.redirect("/dashboard");
});

// --- Setup pages (auth-protected) ---
app.get("/setup", authGuard, (c) => {
	const user = c.get("user");
	const hostname = new URL(c.req.url).hostname;
	return c.html(
		<SetupPage hostname={hostname} userEmail={user.email} />,
	);
});

app.get("/setup/ios", authGuard, (c) => {
	const user = c.get("user");
	const hostname = new URL(c.req.url).hostname;
	const xml = generateMobileconfig(hostname, user.email);
	return c.body(xml, 200, {
		"Content-Type": "application/x-apple-aspen-config",
		"Content-Disposition": 'attachment; filename="caldav.mobileconfig"',
	});
});

// --- Scheduling API (iTIP/iMIP) ---
app.post("/api/scheduling/events", authGuard, async (c) => {
	const user = c.get("user");
	return createScheduledEvent(c, user.id);
});

app.post("/api/scheduling/reply", async (c) => {
	const secret = c.env.SCHEDULING_WEBHOOK_SECRET;
	if (secret) {
		const provided = c.req.header("X-Webhook-Secret") ?? "";
		if (!timingSafeEqualStr(provided, secret)) {
			return c.text("Unauthorized", 401);
		}
	}
	return processReply(c);
});

app.post("/api/scheduling/counter", async (c) => {
	const secret = c.env.SCHEDULING_WEBHOOK_SECRET;
	if (secret) {
		const provided = c.req.header("X-Webhook-Secret") ?? "";
		if (!timingSafeEqualStr(provided, secret)) {
			return c.text("Unauthorized", 401);
		}
	}
	return processCounter(c);
});

app.get("/api/scheduling/events/:uid/attendees", authGuard, async (c) => {
	return getEventAttendees(c);
});

// --- Natural language task CRUD (Workers AI) ---
app.post("/api/tasks/natural", authGuard, async (c) => {
	const user = c.get("user");
	const { calendarId, input } = await c.req.json<{
		calendarId: number;
		input: string;
	}>();
	if (!calendarId || !input) {
		return c.json(
			{ action: "error", message: "calendarId and input are required" },
			400,
		);
	}
	// Verify calendar ownership
	const cal = await getCalendarById(c.env.DB, user.id, calendarId);
	if (!cal) {
		return c.json({ action: "error", message: "Calendar not found" }, 404);
	}
	const result = await processNaturalLanguage(
		c.env.AI,
		c.env.DB,
		user.id,
		calendarId,
		input,
	);
	return c.json(result);
});

// --- MCP endpoint (Streamable HTTP, JSON-RPC) ---
app.all("/mcp", async (c) => {
	const auth = c.req.header("Authorization");
	if (
		!auth?.startsWith("Bearer ") ||
		!timingSafeEqualStr(auth.slice(7), c.env.MCP_TOKEN)
	) {
		return c.text("Unauthorized", 401);
	}
	const userId = c.env.MCP_USER_ID || "default";
	return handleMcpRequest(c.req.raw, c.env.DB, userId, c.env);
});

// --- Webhook API ---
app.post("/api/webhooks", authGuard, async (c) => {
	const user = c.get("user");
	const body = await c.req.json<{
		url?: string;
		events?: string;
		secret?: string;
	}>();
	if (!body.url || !body.secret) {
		return c.json({ error: "url and secret are required" }, 400);
	}
	const events = body.events || "create,update,delete";
	// Validate event names
	const validEvents = ["create", "update", "delete"];
	const eventList = events.split(",").map((e) => e.trim());
	if (eventList.some((e) => !validEvents.includes(e))) {
		return c.json({ error: "Invalid events. Allowed: create, update, delete" }, 400);
	}
	const webhook = await createWebhook(c.env.DB, user.id, body.url, events, body.secret);
	return c.json(webhook, 201);
});

app.get("/api/webhooks", authGuard, async (c) => {
	const user = c.get("user");
	const webhooks = await listWebhooks(c.env.DB, user.id);
	return c.json(webhooks);
});

app.delete("/api/webhooks/:id", authGuard, async (c) => {
	const user = c.get("user");
	const deleted = await deleteWebhook(c.env.DB, user.id, c.req.param("id"));
	if (!deleted) {
		return c.json({ error: "Webhook not found" }, 404);
	}
	return c.body(null, 204);
});

// --- Calendar Sharing API ---
app.post("/api/calendars/:id/share", authGuard, async (c) => {
	const user = c.get("user");
	const calendarId = Number(c.req.param("id"));
	const body = await c.req.json<{
		sharedWith?: string;
		permission?: string;
	}>();
	if (!body.sharedWith) {
		return c.json({ error: "sharedWith is required" }, 400);
	}
	const permission = body.permission || "read";
	if (permission !== "read" && permission !== "read-write") {
		return c.json(
			{ error: "permission must be 'read' or 'read-write'" },
			400,
		);
	}
	try {
		const share = await shareCalendar(
			c.env.DB,
			user.id,
			calendarId,
			body.sharedWith,
			permission,
		);
		if (!share) {
			return c.json({ error: "Calendar not found or not owned by you" }, 404);
		}
		return c.json(share, 201);
	} catch (err: unknown) {
		if (
			err instanceof Error &&
			err.message.includes("UNIQUE constraint failed")
		) {
			return c.json({ error: "Calendar already shared with this user" }, 409);
		}
		throw err;
	}
});

app.get("/api/calendars/:id/shares", authGuard, async (c) => {
	const user = c.get("user");
	const calendarId = Number(c.req.param("id"));
	const shares = await listShares(c.env.DB, calendarId, user.id);
	return c.json(shares);
});

app.delete("/api/calendars/:id/shares/:shareId", authGuard, async (c) => {
	const user = c.get("user");
	const shareId = c.req.param("shareId");
	const revoked = await revokeShare(c.env.DB, shareId, user.id);
	if (!revoked) {
		return c.json({ error: "Share not found" }, 404);
	}
	return c.body(null, 204);
});

app.get("/api/shared-calendars", authGuard, async (c) => {
	const user = c.get("user");
	const shared = await getSharedCalendars(c.env.DB, user.id);
	return c.json(shared);
});

// --- Health check ---
app.get("/health", async (c) => {
	try {
		const result = await c.env.DB.prepare("SELECT 1 AS ok").first<{
			ok: number;
		}>();
		if (result?.ok === 1) {
			return c.json({ status: "ok", db: "connected" });
		}
		return c.json({ status: "degraded", db: "query failed" }, 503);
	} catch (err) {
		return c.json(
			{
				status: "error",
				db: "unreachable",
				error: err instanceof Error ? err.message : "unknown",
			},
			503,
		);
	}
});

// --- CalDAV routes ---
registerCaldavRoutes(app);

export default {
	fetch: app.fetch,
	async email(message: ForwardableEmailMessage, env: CloudflareBindings) {
		await handleEmail(message, env);
	},
	async scheduled(
		controller: ScheduledController,
		env: CloudflareBindings,
	) {
		console.log("[Cron] Gmail poll triggered");

		// Find all users with Google OAuth accounts
		const accounts = await env.DB
			.prepare(
				"SELECT DISTINCT user_id FROM account WHERE provider_id = 'google' AND refresh_token IS NOT NULL",
			)
			.all<{ user_id: string }>();

		const users = accounts.results ?? [];
		if (users.length === 0) {
			console.log("[Cron] No users with Google OAuth tokens found");
			return;
		}

		for (const { user_id: userId } of users) {
			try {
				const accessToken = await getValidAccessToken(
					env.DB,
					userId,
					env.GOOGLE_CLIENT_ID,
					env.GOOGLE_CLIENT_SECRET,
				);
				if (!accessToken) {
					console.error(`[Cron] Could not get access token for user ${userId}`);
					continue;
				}

				// Find a VTODO calendar for this user
				const calendars = await getCalendarsForUser(env.DB, userId);
				const todoCalendar = calendars.find(
					(c) => c.componentType === "VTODO",
				);
				if (!todoCalendar) {
					console.log(`[Cron] No VTODO calendar for user ${userId}`);
					continue;
				}

				const result = await pollGmailForTasks(
					env.AI,
					env.DB,
					accessToken,
					userId,
					todoCalendar.id,
				);
				console.log(
					`[Cron] User ${userId}: created ${result.created} tasks, ${result.errors.length} errors`,
				);
				if (result.errors.length > 0) {
					console.error(`[Cron] Errors:`, result.errors);
				}
			} catch (err) {
				console.error(`[Cron] Error polling for user ${userId}:`, err);
			}
		}
	},
} satisfies ExportedHandler<CloudflareBindings>;
