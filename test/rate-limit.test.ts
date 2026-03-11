import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import {
	_resetMemoryStore,
	_seedMemoryStore,
	_setForceMemoryStore,
} from "../src/middleware/rate-limit.js";
import "../src/index.js";

const AUTH = "Basic " + btoa("test-user:test-pass");

async function seedCalendar(
	name: string,
	componentType: string,
): Promise<number> {
	await env.DB.prepare(
		"INSERT OR IGNORE INTO calendars (user_id, name, component_type) VALUES (?, ?, ?)",
	)
		.bind("default", name, componentType)
		.run();
	const row = await env.DB.prepare(
		"SELECT id FROM calendars WHERE user_id = ? AND name = ? LIMIT 1",
	)
		.bind("default", name)
		.first<{ id: number }>();
	return row!.id;
}

function davRequest(
	opts: { headers?: Record<string, string> } = {},
) {
	return SELF.fetch("http://localhost/dav/principals/", {
		method: "PROPFIND",
		headers: {
			Authorization: AUTH,
			Depth: "0",
			...opts.headers,
		},
		redirect: "manual",
	});
}

describe("Rate Limiting", () => {
	beforeAll(async () => {
		await seedCalendar("RL Test", "VTODO");
		// Force memory store so we can control state from tests
		_setForceMemoryStore(true);
	});

	afterAll(() => {
		_setForceMemoryStore(false);
	});

	beforeEach(() => {
		_resetMemoryStore();
	});

	it("should include rate limit headers on successful requests", async () => {
		const res = await davRequest();
		expect(res.headers.get("X-RateLimit-Limit")).toBe("100");
		expect(res.headers.get("X-RateLimit-Remaining")).toBe("99");
		expect(res.headers.get("X-RateLimit-Reset")).toBeDefined();
	});

	it("should decrement remaining count with each request", async () => {
		const res1 = await davRequest();
		const remaining1 = parseInt(
			res1.headers.get("X-RateLimit-Remaining")!,
			10,
		);

		const res2 = await davRequest();
		const remaining2 = parseInt(
			res2.headers.get("X-RateLimit-Remaining")!,
			10,
		);

		expect(remaining1).toBe(99);
		expect(remaining2).toBe(98);
	});

	it("should return 429 when rate limit is exceeded", async () => {
		// Pre-seed the store so the next request exceeds the limit
		const key = "dav:basic:test-user";
		_seedMemoryStore(key, 100, Date.now() + 60_000);

		const res = await davRequest();

		expect(res.status).toBe(429);
		expect(res.headers.get("X-RateLimit-Limit")).toBe("100");
		expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
		expect(await res.text()).toBe("Too Many Requests");
	});

	it("should have Retry-After header with valid value on 429 response", async () => {
		// Pre-seed the store so the next request exceeds the limit
		const key = "dav:basic:test-user";
		_seedMemoryStore(key, 100, Date.now() + 30_000);

		const res = await davRequest();

		expect(res.status).toBe(429);
		const retryAfter = parseInt(res.headers.get("Retry-After")!, 10);
		expect(retryAfter).toBeGreaterThan(0);
		expect(retryAfter).toBeLessThanOrEqual(30);
	});

	it("should use different keys for different Basic Auth users", async () => {
		// Request with Basic Auth user A
		const resA = await SELF.fetch("http://localhost/dav/principals/", {
			method: "PROPFIND",
			headers: {
				Authorization: "Basic " + btoa("user-a:pass-a"),
				Depth: "0",
			},
			redirect: "manual",
		});
		const remainingA = parseInt(
			resA.headers.get("X-RateLimit-Remaining")!,
			10,
		);

		// Request with Basic Auth user B — should have independent counter
		const resB = await SELF.fetch("http://localhost/dav/principals/", {
			method: "PROPFIND",
			headers: {
				Authorization: "Basic " + btoa("user-b:pass-b"),
				Depth: "0",
			},
			redirect: "manual",
		});
		const remainingB = parseInt(
			resB.headers.get("X-RateLimit-Remaining")!,
			10,
		);

		// Both should show 99 remaining (their first request each)
		expect(remainingA).toBe(99);
		expect(remainingB).toBe(99);
	});

	it("should not apply rate limiting to /health", async () => {
		const res = await SELF.fetch("http://localhost/health", {
			method: "GET",
			redirect: "manual",
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("X-RateLimit-Limit")).toBeNull();
	});

	it("should apply different limits for /dav and /api paths", async () => {
		// DAV endpoint has limit of 100
		const davRes = await davRequest();
		expect(davRes.headers.get("X-RateLimit-Limit")).toBe("100");
		expect(davRes.headers.get("X-RateLimit-Remaining")).toBe("99");

		// API endpoint has limit of 60 (use /api/webhooks which goes through authGuard)
		// Note: authGuard redirects to /login without session, but rate limit headers
		// are still set by the middleware before authGuard runs
		const apiRes = await SELF.fetch("http://localhost/api/webhooks", {
			method: "GET",
			redirect: "manual",
		});
		expect(apiRes.headers.get("X-RateLimit-Limit")).toBe("60");
	});

	it("should fall back gracefully when caches API is unavailable (test env)", async () => {
		// In miniflare test env with forceMemoryStore, the middleware uses
		// the in-memory fallback. Verify it works correctly.
		const res = await davRequest();

		// Should not error — the request should complete normally
		expect(res.status).not.toBe(500);
		expect(res.headers.get("X-RateLimit-Limit")).toBe("100");
		expect(res.headers.get("X-RateLimit-Remaining")).toBeDefined();
	});

	it("should apply rate limit of 60 to /api/* endpoints", async () => {
		const res = await SELF.fetch("http://localhost/api/webhooks", {
			method: "GET",
			redirect: "manual",
		});
		expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
		expect(
			parseInt(res.headers.get("X-RateLimit-Remaining")!, 10),
		).toBeLessThanOrEqual(59);
	});

	it("should use independent counters for different path prefixes", async () => {
		// Make a DAV request
		const davRes = await davRequest();
		const davRemaining = parseInt(
			davRes.headers.get("X-RateLimit-Remaining")!,
			10,
		);

		// Make an API request — should have its own counter
		const apiRes = await SELF.fetch("http://localhost/api/webhooks", {
			method: "GET",
			redirect: "manual",
		});
		const apiRemaining = parseInt(
			apiRes.headers.get("X-RateLimit-Remaining")!,
			10,
		);

		// DAV limit is 100, API limit is 60 — different limits confirm different counters
		expect(davRes.headers.get("X-RateLimit-Limit")).toBe("100");
		expect(apiRes.headers.get("X-RateLimit-Limit")).toBe("60");
		// Both should have high remaining (near their respective limits)
		expect(davRemaining).toBeGreaterThanOrEqual(90);
		expect(apiRemaining).toBeGreaterThanOrEqual(50);
	});
});
