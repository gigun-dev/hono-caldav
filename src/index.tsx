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

// --- CalDAV routes ---
registerCaldavRoutes(app);

export default app;
