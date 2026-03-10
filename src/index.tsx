import { Hono } from "hono";

import { createAuth } from "./auth/auth.js";
import {
	createAppPassword,
	listAppPasswords,
	revokeAppPassword,
} from "./auth/app-password.js";
import { registerCaldavRoutes } from "./caldav/handlers.js";
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

// Debug middleware: log request details for CalDAV debugging
app.use("/dav/*", async (c, next) => {
	const method = c.req.method;
	const path = c.req.path;
	const depth = c.req.header("depth") ?? "-";
	const contentType = c.req.header("content-type") ?? "-";
	console.log(`[CalDAV] ${method} ${path} Depth:${depth} CT:${contentType}`);
	if (["PUT", "PROPPATCH", "REPORT", "MKCOL"].includes(method)) {
		const body = await c.req.raw.clone().text();
		console.log(`[CalDAV] Body (${body.length} bytes):\n${body.slice(0, 500)}`);
	}
	await next();
	console.log(`[CalDAV] ${method} ${path} → ${c.res.status}`);
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
