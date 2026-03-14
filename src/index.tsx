import { Hono } from "hono";

import type { AppBindings } from "./types.js";
import { createAuth } from "./auth/auth.js";
import {
	generateAppPassword,
	listAppPasswords,
	revokeAppPassword,
} from "./auth/app-password.js";
import { caldavAuth } from "./middleware/caldav-auth.js";
import { authGuard } from "./middleware/auth-guard.js";
import { registerCaldavRoutes } from "./caldav/handlers.js";
import LoginPage from "./pages/login.js";
import DashboardPage from "./pages/dashboard.js";
import { handleDemo, handleDemoSeed } from "./demo/handler.js";
import { cleanupDemoUsers } from "./demo/cleanup.js";
import cronRoute from "./routes/cron.js";

const app = new Hono<AppBindings>();

// --- Health check ---
app.get("/", (c) => c.text("CalDAV VTODO server is running."));

// --- better-auth handler ---
app.on(["POST", "GET"], "/api/auth/*", (c) => {
	const auth = createAuth(c.env, c.req.raw.headers);
	return auth.handler(c.req.raw);
});

// --- Login page ---
app.get("/login", (c) => {
	return c.html(<LoginPage />);
});

// --- Demo mode ---
app.get("/demo", handleDemo);
app.post("/demo/seed", caldavAuth, handleDemoSeed);

// --- Dashboard (session protected) ---
app.get("/dashboard", authGuard, async (c) => {
	const user = c.get("user");
	const passwords = await listAppPasswords(c.env.DB, user.id);
	const isDemo = user.username.endsWith("@demo.caldav.local");
	return c.html(
		<DashboardPage
			userName={user.displayName ?? user.username}
			userEmail={user.username}
			passwords={passwords}
			isDemo={isDemo}
		/>,
	);
});

// --- App Password API (session protected) ---
app.post("/api/app-passwords", authGuard, async (c) => {
	const user = c.get("user");
	const result = await generateAppPassword(c.env.DB, user.id);

	// Return htmx partial with the generated password
	return c.html(
		<div class="new-password">
			<strong>App Password (一度だけ表示):</strong>
			<code id="generated-password-value">{result.password}</code>
			<p class="info">
				この値をコピーして CalDAV クライアントに設定してください。再表示できません。
			</p>
		</div>,
	);
});

app.get("/api/app-passwords", authGuard, async (c) => {
	const user = c.get("user");
	const passwords = await listAppPasswords(c.env.DB, user.id);
	return c.json(passwords);
});

app.post("/api/app-passwords/:id/revoke", authGuard, async (c) => {
	const user = c.get("user");
	const passwordId = c.req.param("id");
	const revoked = await revokeAppPassword(c.env.DB, user.id, passwordId);
	if (!revoked) {
		return c.text("Not found", 404);
	}
	// Return empty string to remove the row via hx-swap="outerHTML"
	return c.body(null, 200);
});

// --- Cron (e.g. GET /cron/poll for local testing) ---
app.route("/cron", cronRoute);

// --- Debug middleware for CalDAV ---
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

// --- CalDAV auth middleware ---
app.use("/dav/*", caldavAuth);

// PROPFIND / also needs CalDAV auth (iOS hits this on initial connect)
app.on("PROPFIND", "/", caldavAuth);

// --- CalDAV routes ---
registerCaldavRoutes(app);

export default app;

// Cron Trigger handler for demo user cleanup
export async function scheduled(
	_event: ScheduledEvent,
	env: CloudflareBindings,
	_ctx: ExecutionContext,
) {
	const result = await cleanupDemoUsers(env.DB);
	console.log(`[Cron] Cleaned up ${result.deleted} demo users`);
}
