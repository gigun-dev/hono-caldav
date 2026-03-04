import { Hono } from "hono";

import { registerCaldavRoutes } from "./caldav/handlers";

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

app.get("/", (c) => c.text("CalDAV VTODO server is running."));

registerCaldavRoutes(app);

export default app;
