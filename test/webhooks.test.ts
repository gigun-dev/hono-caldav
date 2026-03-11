import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import "../src/index.js";
import {
	computeHmacSignature,
	getMatchingWebhooks,
	createWebhook,
	listWebhooks,
	deleteWebhook,
	fireWebhook,
} from "../src/webhooks/notify.js";

// --- Helpers ---

// For CalDAV Basic Auth
const AUTH = "Basic " + btoa("test-user:test-pass");

// We need a session cookie for authGuard-protected routes.
// Since better-auth requires Google OAuth in this setup, we'll test
// the webhook CRUD functions directly against D1 and test the
// HMAC signature computation.

function makeVtodo(uid: string, summary: string): string {
	return [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Test//Test//EN",
		"BEGIN:VTODO",
		`UID:${uid}`,
		`DTSTAMP:20250101T000000Z`,
		`SUMMARY:${summary}`,
		"STATUS:NEEDS-ACTION",
		"END:VTODO",
		"END:VCALENDAR",
	].join("\r\n");
}

async function seedCalendar(
	name: string,
	componentType: string,
): Promise<number> {
	await env.DB.prepare(
		"INSERT INTO calendars (user_id, name, component_type) VALUES (?, ?, ?)",
	)
		.bind("webhook-test-user", name, componentType)
		.run();
	const row = await env.DB.prepare(
		"SELECT id FROM calendars WHERE user_id = ? ORDER BY id DESC LIMIT 1",
	)
		.bind("webhook-test-user")
		.first<{ id: number }>();
	return row!.id;
}

// === HMAC Signature Tests ===

describe("computeHmacSignature", () => {
	it("produces a deterministic hex signature", async () => {
		const sig1 = await computeHmacSignature("my-secret", '{"event":"create"}');
		const sig2 = await computeHmacSignature("my-secret", '{"event":"create"}');
		expect(sig1).toBe(sig2);
		expect(sig1).toMatch(/^[0-9a-f]{64}$/);
	});

	it("produces different signatures for different secrets", async () => {
		const sig1 = await computeHmacSignature("secret-a", "payload");
		const sig2 = await computeHmacSignature("secret-b", "payload");
		expect(sig1).not.toBe(sig2);
	});

	it("produces different signatures for different payloads", async () => {
		const sig1 = await computeHmacSignature("same-secret", "payload-1");
		const sig2 = await computeHmacSignature("same-secret", "payload-2");
		expect(sig1).not.toBe(sig2);
	});
});

// === Webhook CRUD (direct DB) ===

describe("Webhook CRUD", () => {
	const userId = "webhook-crud-user";

	beforeEach(async () => {
		await env.DB.prepare("DELETE FROM webhooks WHERE user_id = ?")
			.bind(userId)
			.run();
	});

	it("creates and lists webhooks", async () => {
		const wh = await createWebhook(
			env.DB,
			userId,
			"https://example.com/hook",
			"create,update",
			"test-secret",
		);
		expect(wh.id).toBeDefined();
		expect(wh.url).toBe("https://example.com/hook");
		expect(wh.events).toBe("create,update");
		expect(wh.active).toBe(true);

		const list = await listWebhooks(env.DB, userId);
		expect(list).toHaveLength(1);
		expect(list[0]!.id).toBe(wh.id);
	});

	it("deletes a webhook", async () => {
		const wh = await createWebhook(
			env.DB,
			userId,
			"https://example.com/hook",
			"create",
			"secret",
		);
		const deleted = await deleteWebhook(env.DB, userId, wh.id);
		expect(deleted).toBe(true);

		const list = await listWebhooks(env.DB, userId);
		expect(list).toHaveLength(0);
	});

	it("returns false when deleting non-existent webhook", async () => {
		const deleted = await deleteWebhook(env.DB, userId, "nonexistent");
		expect(deleted).toBe(false);
	});

	it("does not delete another user's webhook", async () => {
		const wh = await createWebhook(
			env.DB,
			userId,
			"https://example.com/hook",
			"create",
			"secret",
		);
		const deleted = await deleteWebhook(env.DB, "other-user", wh.id);
		expect(deleted).toBe(false);

		const list = await listWebhooks(env.DB, userId);
		expect(list).toHaveLength(1);
	});
});

// === Event matching ===

describe("getMatchingWebhooks", () => {
	const userId = "webhook-match-user";

	beforeEach(async () => {
		await env.DB.prepare("DELETE FROM webhooks WHERE user_id = ?")
			.bind(userId)
			.run();
	});

	it("matches webhooks subscribed to the event", async () => {
		await createWebhook(
			env.DB,
			userId,
			"https://example.com/create-only",
			"create",
			"s1",
		);
		await createWebhook(
			env.DB,
			userId,
			"https://example.com/all",
			"create,update,delete",
			"s2",
		);

		const createMatches = await getMatchingWebhooks(env.DB, userId, "create");
		expect(createMatches).toHaveLength(2);

		const deleteMatches = await getMatchingWebhooks(env.DB, userId, "delete");
		expect(deleteMatches).toHaveLength(1);
		expect(deleteMatches[0]!.url).toBe("https://example.com/all");
	});

	it("does not match inactive webhooks", async () => {
		const wh = await createWebhook(
			env.DB,
			userId,
			"https://example.com/hook",
			"create",
			"secret",
		);
		// Deactivate
		await env.DB.prepare("UPDATE webhooks SET active = 0 WHERE id = ?")
			.bind(wh.id)
			.run();

		const matches = await getMatchingWebhooks(env.DB, userId, "create");
		expect(matches).toHaveLength(0);
	});

	it("does not match webhooks for other events", async () => {
		await createWebhook(
			env.DB,
			userId,
			"https://example.com/hook",
			"update",
			"secret",
		);

		const matches = await getMatchingWebhooks(env.DB, userId, "create");
		expect(matches).toHaveLength(0);
	});
});

// === fireWebhook integration (via CalDAV PUT/DELETE) ===

describe("Webhook fires on CalDAV operations", () => {
	let calendarId: number;

	beforeAll(async () => {
		// Seed a calendar for the default user (used by Basic Auth)
		calendarId = await seedCalendar("Webhook Test", "VTODO");
		// Remap to "default" user since CalDAV auth maps to "default"
		await env.DB.prepare("UPDATE calendars SET user_id = ? WHERE id = ?")
			.bind("default", calendarId)
			.run();
	});

	beforeEach(async () => {
		await env.DB.prepare("DELETE FROM webhooks WHERE user_id = ?")
			.bind("default")
			.run();
	});

	it("fireWebhook does not throw when no webhooks registered", async () => {
		// Should not throw even with no webhooks
		await fireWebhook(env.DB, "default", "create", {
			calendarId: 1,
			uid: "test-uid",
		});
	});

	it("CalDAV PUT creates an object (webhook integration point)", async () => {
		// Register a webhook (it will try to POST to a non-existent URL, but should not break the request)
		await createWebhook(
			env.DB,
			"default",
			"https://httpbin.org/post",
			"create",
			"test-secret",
		);

		const res = await SELF.fetch(
			`http://localhost/dav/projects/${calendarId}/webhook-test-1.ics`,
			{
				method: "PUT",
				headers: {
					Authorization: AUTH,
					"Content-Type": "text/calendar",
				},
				body: makeVtodo("webhook-test-1", "Webhook Test Task"),
			},
		);
		// The PUT should still succeed even if webhook delivery fails
		expect(res.status).toBe(201);
	});

	it("CalDAV DELETE works with webhook registered", async () => {
		// First create the object
		await SELF.fetch(
			`http://localhost/dav/projects/${calendarId}/webhook-del-1.ics`,
			{
				method: "PUT",
				headers: {
					Authorization: AUTH,
					"Content-Type": "text/calendar",
				},
				body: makeVtodo("webhook-del-1", "To be deleted"),
			},
		);

		// Register a delete webhook
		await createWebhook(
			env.DB,
			"default",
			"https://httpbin.org/post",
			"delete",
			"test-secret",
		);

		const res = await SELF.fetch(
			`http://localhost/dav/projects/${calendarId}/webhook-del-1.ics`,
			{
				method: "DELETE",
				headers: {
					Authorization: AUTH,
				},
			},
		);
		expect(res.status).toBe(204);
	});
});
