/**
 * MKCALENDAR Method-Rewriting Proxy (ローカル開発用)
 *
 * workerd (wrangler dev) の KJ parser は MKCALENDAR を受け付けないため、
 * MKCALENDAR → POST + X-Caldav-Method ヘッダーに書き換えて転送する。
 *
 * 構成:
 *   iOS → cloudflared tunnel (port 3001) → このproxy → wrangler dev (port 8787)
 *
 * 起動:
 *   bun run proxy/dev.ts
 */

const WRANGLER_URL = process.env.WRANGLER_URL ?? "http://localhost:8787"

const server = Bun.serve({
	port: Number(process.env.PORT ?? 3001),
	hostname: "0.0.0.0",
	async fetch(req) {
		const url = new URL(req.url)
		const method = req.method
		const targetUrl = WRANGLER_URL + url.pathname + url.search

		const headers = new Headers(req.headers)
		let fetchMethod = method

		if (method === "MKCALENDAR") {
			fetchMethod = "POST"
			headers.set("X-Caldav-Method", "MKCALENDAR")
			console.log(`[proxy] MKCALENDAR → POST + X-Caldav-Method ${url.pathname}`)
		}

		headers.delete("host")

		const resp = await fetch(targetUrl, {
			method: fetchMethod,
			headers,
			body: req.body,
			redirect: "manual",
		})

		return new Response(resp.body, {
			status: resp.status,
			headers: resp.headers,
		})
	},
})

console.log(`[proxy] Listening on http://localhost:${server.port}`)
console.log(`[proxy] → ${WRANGLER_URL}`)
console.log(`[proxy] Rewriting: MKCALENDAR → POST + X-Caldav-Method`)
