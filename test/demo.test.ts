import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import "../src/index";

describe("Demo mode", () => {
	it("GET /demo returns 302 with Set-Cookie and creates demo data", async () => {
		const res = await SELF.fetch("http://localhost/demo", {
			redirect: "manual",
		});
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/dashboard");
		expect(res.headers.get("set-cookie")).toBeTruthy();

		// Find the anonymous demo user (email ends with @demo.caldav.local)
		const user = await env.DB.prepare(
			`SELECT id, email FROM "user" WHERE email LIKE '%@demo.caldav.local'`,
		).first<{ id: string; email: string }>();
		expect(user).toBeTruthy();

		// Check calendars were seeded
		const calendars = await env.DB.prepare(
			"SELECT name, component_type, color FROM calendars WHERE user_id = ? ORDER BY id ASC",
		)
			.bind(user!.id)
			.all();
		expect(calendars.results).toHaveLength(3);
		expect(calendars.results![0].name).toBe("仕事");
		expect(calendars.results![0].component_type).toBe("VTODO");
		expect(calendars.results![1].name).toBe("プライベート");
		expect(calendars.results![2].name).toBe("スケジュール");
		expect(calendars.results![2].component_type).toBe("VEVENT");

		// Check objects count: 3 work + 3 private + 2 schedule = 8
		const objects = await env.DB.prepare(
			"SELECT uid FROM calendar_objects WHERE calendar_id IN (SELECT id FROM calendars WHERE user_id = ?) ORDER BY uid",
		)
			.bind(user!.id)
			.all();
		expect(objects.results).toHaveLength(8);

		// App Password is NOT auto-generated (user creates it via dashboard)
		const appPw = await env.DB.prepare(
			"SELECT id FROM app_passwords WHERE user_id = ?",
		)
			.bind(user!.id)
			.first();
		expect(appPw).toBeNull();
	});

	it("POST /demo/seed creates data for authenticated user", async () => {
		// Use test user A (seeded in apply-migrations.ts)
		const AUTH = "Basic " + btoa("admin:changeme");
		const res = await SELF.fetch("http://localhost/demo/seed", {
			method: "POST",
			headers: { Authorization: AUTH },
		});
		expect(res.status).toBe(200);
		const data = await res.json<{ ok: boolean; userId: string }>();
		expect(data.ok).toBe(true);
		expect(data.userId).toBe("test-user-a");

		// Verify calendars were created
		const calendars = await env.DB.prepare(
			"SELECT name FROM calendars WHERE user_id = 'test-user-a' ORDER BY id ASC",
		).all();
		expect(calendars.results.length).toBeGreaterThanOrEqual(3);
	});
});

describe("Demo cleanup", () => {
	it("deletes old demo users but keeps non-demo and recent demo users", async () => {
		// Create a recent demo user (should survive cleanup)
		await env.DB.prepare(
			`INSERT OR IGNORE INTO "user" (id, name, email, "createdAt", "updatedAt") VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
		)
			.bind(
				"recent-demo-user",
				"Recent Demo",
				"recent-demo@demo.caldav.local",
			)
			.run();
		await env.DB.prepare(
			"INSERT INTO calendars (user_id, name, component_type) VALUES (?, ?, ?)",
		)
			.bind("recent-demo-user", "Recent Cal", "VTODO")
			.run();

		// Create an old demo user (25h ago, should be deleted)
		await env.DB.prepare(
			`INSERT INTO "user" (id, name, email, "createdAt", "updatedAt") VALUES (?, ?, ?, datetime('now', '-25 hours'), datetime('now', '-25 hours'))`,
		)
			.bind("old-demo-user", "Old Demo", "old-demo@demo.caldav.local")
			.run();
		await env.DB.prepare(
			"INSERT INTO calendars (user_id, name, component_type) VALUES (?, ?, ?)",
		)
			.bind("old-demo-user", "Old Cal", "VTODO")
			.run();

		// Run cleanup
		const { cleanupDemoUsers } = await import("../src/demo/cleanup.js");
		const result = await cleanupDemoUsers(env.DB);
		expect(result.deleted).toBe(1);

		// Old demo user should be gone
		const oldUser = await env.DB.prepare(
			`SELECT id FROM "user" WHERE id = 'old-demo-user'`,
		).first();
		expect(oldUser).toBeNull();

		// Non-demo users should still exist
		const testUser = await env.DB.prepare(
			`SELECT id FROM "user" WHERE id = 'test-user-a'`,
		).first();
		expect(testUser).toBeTruthy();

		// Recent demo user should still exist
		const recentDemo = await env.DB.prepare(
			`SELECT id FROM "user" WHERE id = 'recent-demo-user'`,
		).first();
		expect(recentDemo).toBeTruthy();
	});
});
