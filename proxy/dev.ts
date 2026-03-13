/**
 * MKCALENDAR Method-Rewriting Proxy
 *
 * workerd の KJ parser は MKCALENDAR を受け付けないため、
 * MKCALENDAR → POST + X-Caldav-Method ヘッダーに書き換えて転送する。
 *
 * ローカル:
 *   bun run proxy/dev.ts
 *   iOS → cloudflared tunnel (port 3001) → proxy → wrangler dev (port 8787)
 *
 * Cloud Run (本番 + preview):
 *   Host ヘッダーをそのまま転送先に使う。
 *   caldav.gigun-dev.workers.dev → 本番
 *   <branch>-caldav.gigun-dev.workers.dev → preview
 */

const LOCAL_TARGET = process.env.LOCAL_TARGET ?? "http://localhost:8787";

function getTargetUrl(req: Request, url: URL): string {
	const host = req.headers.get("host") ?? "";
	if (host.endsWith(".workers.dev")) {
		return `https://${host}${url.pathname}${url.search}`;
	}
	return `${LOCAL_TARGET}${url.pathname}${url.search}`;
}

const server = Bun.serve({
	port: Number(process.env.PORT ?? 3001),
	hostname: "0.0.0.0",
	async fetch(req) {
		const url = new URL(req.url);
		const method = req.method;
		const targetUrl = getTargetUrl(req, url);

		const headers = new Headers(req.headers);
		let fetchMethod = method;

		if (method === "MKCALENDAR") {
			fetchMethod = "POST";
			headers.set("X-Caldav-Method", "MKCALENDAR");
			console.log(
				`[proxy] MKCALENDAR → POST + X-Caldav-Method ${url.pathname}`,
			);
		}

		const originalHost = headers.get("host") ?? "";
		console.log(`[proxy] ${method} ${url.pathname} Host:${originalHost} XFH:${headers.get("X-Forwarded-Host")} XFP:${headers.get("X-Forwarded-Proto")}`);
		if (!headers.has("X-Forwarded-Host")) {
			headers.set("X-Forwarded-Host", originalHost);
		}
		if (!headers.has("X-Forwarded-Proto")) {
			headers.set("X-Forwarded-Proto", url.protocol.replace(":", ""));
		}
		headers.delete("host");

		const resp = await fetch(targetUrl, {
			method: fetchMethod,
			headers,
			body: req.body,
			redirect: "manual",
		});

		return new Response(resp.body, {
			status: resp.status,
			headers: resp.headers,
		});
	},
});

console.log(`[proxy] Listening on http://localhost:${server.port}`);
console.log(`[proxy] Local fallback: ${LOCAL_TARGET}`);
console.log(`[proxy] Remote: Host *.workers.dev → https://{host}`);
console.log(`[proxy] Rewriting: MKCALENDAR → POST + X-Caldav-Method`);
