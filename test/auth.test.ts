import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import "../src/index";
import {
	AUTH_A,
	AUTH_B,
	request,
	makeVtodo,
	seedCalendar,
} from "./helpers.js";

// === Multi-user isolation ===

describe("Multi-user isolation", () => {
	let calIdA: number;
	let calIdB: number;

	beforeAll(async () => {
		calIdA = await seedCalendar("User A Calendar", "VTODO", "test-user-a");
		calIdB = await seedCalendar("User B Calendar", "VTODO", "test-user-b");

		// Seed data for each user
		const icsA = makeVtodo("iso-a-1", "User A Task");
		await request(
			"PUT",
			`/dav/projects/${calIdA}/iso-a-1.ics`,
			AUTH_A,
			{ body: icsA, headers: { "Content-Type": "text/calendar" } },
		);

		const icsB = makeVtodo("iso-b-1", "User B Task");
		await request(
			"PUT",
			`/dav/projects/${calIdB}/iso-b-1.ics`,
			AUTH_B,
			{ body: icsB, headers: { "Content-Type": "text/calendar" } },
		);
	});

	it("User A cannot access User B's calendar", async () => {
		const res = await request(
			"PROPFIND",
			`/dav/projects/${calIdB}/`,
			AUTH_A,
			{ headers: { Depth: "0" } },
		);
		expect(res.status).toBe(404);
	});

	it("User B cannot access User A's calendar", async () => {
		const res = await request(
			"PROPFIND",
			`/dav/projects/${calIdA}/`,
			AUTH_B,
			{ headers: { Depth: "0" } },
		);
		expect(res.status).toBe(404);
	});

	it("User A cannot GET User B's object", async () => {
		const res = await request(
			"GET",
			`/dav/projects/${calIdB}/iso-b-1.ics`,
			AUTH_A,
		);
		expect(res.status).toBe(404);
	});

	it("User B cannot DELETE User A's object", async () => {
		const res = await request(
			"DELETE",
			`/dav/projects/${calIdA}/iso-a-1.ics`,
			AUTH_B,
		);
		expect(res.status).toBe(404);
	});

	it("User B cannot DELETE User A's calendar", async () => {
		const res = await request(
			"DELETE",
			`/dav/projects/${calIdA}`,
			AUTH_B,
		);
		expect(res.status).toBe(404);

		// Verify calendar still exists for User A
		const checkRes = await request(
			"PROPFIND",
			`/dav/projects/${calIdA}/`,
			AUTH_A,
			{ headers: { Depth: "0" } },
		);
		expect(checkRes.status).toBe(207);
	});

	it("PROPFIND /dav/projects/ only shows own calendars", async () => {
		const resA = await request("PROPFIND", "/dav/projects/", AUTH_A, {
			headers: { Depth: "1" },
		});
		const xmlA = await resA.text();
		expect(xmlA).toContain("User A Calendar");
		expect(xmlA).not.toContain("User B Calendar");

		const resB = await request("PROPFIND", "/dav/projects/", AUTH_B, {
			headers: { Depth: "1" },
		});
		const xmlB = await resB.text();
		expect(xmlB).toContain("User B Calendar");
		expect(xmlB).not.toContain("User A Calendar");
	});
});

// === App Password CRUD ===

describe("App Password operations", () => {
	it("verifies valid app password returns user info", async () => {
		const res = await request("PROPFIND", "/dav/", AUTH_A);
		expect(res.status).toBe(207);
		const xml = await res.text();
		expect(xml).toContain("admin");
	});

	it("rejects revoked app password", async () => {
		await env.DB.prepare(
			"UPDATE app_passwords SET revoked_at = datetime('now') WHERE id = ?",
		)
			.bind("test-pw-a")
			.run();

		const res = await request("PROPFIND", "/dav/", AUTH_A);
		expect(res.status).toBe(401);

		// Restore for other tests
		await env.DB.prepare(
			"UPDATE app_passwords SET revoked_at = NULL WHERE id = ?",
		)
			.bind("test-pw-a")
			.run();
	});

	it("rejects non-existent user", async () => {
		const badAuth = "Basic " + btoa("nobody:changeme");
		const res = await request("PROPFIND", "/dav/", badAuth);
		expect(res.status).toBe(401);
	});
});
