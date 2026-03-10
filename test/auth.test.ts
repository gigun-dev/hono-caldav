import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import "../src/index.js";
import {
	generateAppPassword,
	verifyAppPassword,
	createAppPassword,
	listAppPasswords,
	revokeAppPassword,
	authenticateWithAppPassword,
} from "../src/auth/app-password.js";

// --- App Password unit tests ---

describe("App Password generation", () => {
	it("generates a 32-char password with hash and prefix", async () => {
		const { plain, hash, prefix } = await generateAppPassword();
		expect(plain.length).toBeLessThanOrEqual(32);
		expect(plain.length).toBeGreaterThanOrEqual(20);
		expect(hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{64}$/);
		expect(prefix).toBe(plain.slice(0, 8));
	});

	it("verifies correct password", async () => {
		const { plain, hash } = await generateAppPassword();
		expect(await verifyAppPassword(plain, hash)).toBe(true);
	});

	it("rejects wrong password", async () => {
		const { hash } = await generateAppPassword();
		expect(await verifyAppPassword("wrong-password", hash)).toBe(false);
	});
});

// --- App Password D1 CRUD tests ---

describe("App Password CRUD", () => {
	let testUserId: string;

	beforeAll(async () => {
		// Create a test user in the user table
		testUserId = "test-user-" + crypto.randomUUID().slice(0, 8);
		await env.DB.prepare(
			'INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)',
		)
			.bind(testUserId, "Test User", `${testUserId}@example.com`)
			.run();
	});

	it("creates and lists app passwords", async () => {
		const { appPassword, plainPassword } = await createAppPassword(
			env.DB,
			testUserId,
			"iOS Reminders",
		);
		expect(appPassword.name).toBe("iOS Reminders");
		expect(appPassword.userId).toBe(testUserId);
		expect(plainPassword.length).toBeGreaterThan(0);

		const list = await listAppPasswords(env.DB, testUserId);
		expect(list.length).toBe(1);
		expect(list[0].name).toBe("iOS Reminders");
	});

	it("revokes app password", async () => {
		const { appPassword } = await createAppPassword(
			env.DB,
			testUserId,
			"To Revoke",
		);

		const revoked = await revokeAppPassword(
			env.DB,
			testUserId,
			appPassword.id,
		);
		expect(revoked).toBe(true);

		// Should not appear in active list
		const list = await listAppPasswords(env.DB, testUserId);
		expect(list.find((p) => p.id === appPassword.id)).toBeUndefined();
	});

	it("authenticates with valid app password", async () => {
		const email = `${testUserId}@example.com`;
		const { plainPassword } = await createAppPassword(
			env.DB,
			testUserId,
			"Auth Test",
		);

		const userId = await authenticateWithAppPassword(
			env.DB,
			email,
			plainPassword,
		);
		expect(userId).toBe(testUserId);
	});

	it("rejects invalid password", async () => {
		const email = `${testUserId}@example.com`;
		const userId = await authenticateWithAppPassword(
			env.DB,
			email,
			"invalid-password",
		);
		expect(userId).toBeNull();
	});

	it("rejects unknown email", async () => {
		const userId = await authenticateWithAppPassword(
			env.DB,
			"nobody@example.com",
			"any-password",
		);
		expect(userId).toBeNull();
	});
});

// --- CalDAV Auth with App Password integration test ---

describe("CalDAV with App Password", () => {
	let testUserId: string;
	let testEmail: string;
	let plainPassword: string;
	let calendarId: number;

	beforeAll(async () => {
		testUserId = "caldav-user-" + crypto.randomUUID().slice(0, 8);
		testEmail = `${testUserId}@example.com`;

		// Create user
		await env.DB.prepare(
			'INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)',
		)
			.bind(testUserId, "CalDAV Test User", testEmail)
			.run();

		// Create app password
		const result = await createAppPassword(
			env.DB,
			testUserId,
			"Test CalDAV",
		);
		plainPassword = result.plainPassword;

		// Create calendar for this user
		await env.DB.prepare(
			"INSERT INTO calendars (user_id, name, component_type) VALUES (?, ?, ?)",
		)
			.bind(testUserId, "App Password Calendar", "VTODO")
			.run();
		const row = await env.DB.prepare(
			"SELECT id FROM calendars WHERE user_id = ? ORDER BY id DESC LIMIT 1",
		)
			.bind(testUserId)
			.first<{ id: number }>();
		calendarId = row!.id;
	});

	it("authenticates PROPFIND with App Password", async () => {
		const auth = "Basic " + btoa(`${testEmail}:${plainPassword}`);
		const res = await SELF.fetch("http://localhost/dav/", {
			method: "PROPFIND",
			headers: { Authorization: auth },
		});
		expect(res.status).toBe(207);
	});

	it("creates and reads a VTODO with App Password", async () => {
		const auth = "Basic " + btoa(`${testEmail}:${plainPassword}`);
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//Test//Test//EN",
			"BEGIN:VTODO",
			"UID:app-pw-test-1",
			"DTSTAMP:20250101T000000Z",
			"SUMMARY:App Password Task",
			"STATUS:NEEDS-ACTION",
			"END:VTODO",
			"END:VCALENDAR",
		].join("\r\n");

		const putRes = await SELF.fetch(
			`http://localhost/dav/projects/${calendarId}/app-pw-test-1.ics`,
			{
				method: "PUT",
				headers: {
					Authorization: auth,
					"Content-Type": "text/calendar",
				},
				body: ics,
			},
		);
		expect(putRes.status).toBe(201);

		const getRes = await SELF.fetch(
			`http://localhost/dav/projects/${calendarId}/app-pw-test-1.ics`,
			{
				method: "GET",
				headers: { Authorization: auth },
			},
		);
		expect(getRes.status).toBe(200);
		const text = await getRes.text();
		expect(text).toContain("App Password Task");
	});

	it("isolates calendars between users", async () => {
		// Legacy user should not see app-password user's calendar
		const legacyAuth = "Basic " + btoa("test-user:test-pass");
		const res = await SELF.fetch(
			`http://localhost/dav/projects/${calendarId}/`,
			{
				method: "PROPFIND",
				headers: { Authorization: legacyAuth, Depth: "0" },
			},
		);
		expect(res.status).toBe(404);
	});
});
