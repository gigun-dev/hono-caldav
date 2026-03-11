import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import "../src/index.js";
import {
	getUserTier,
	getUserTierInfo,
	checkCalendarLimit,
	checkObjectLimit,
	setUserTier,
	TIER_LIMITS,
} from "../src/middleware/tier-limits.js";

// --- Helpers ---

const AUTH = "Basic " + btoa("test-user:test-pass");
const USER_ID = "default"; // Legacy auth user id

// Test user IDs that need a "user" table row for FK constraints
const TIER_TEST_USERS = [
	"tier-user-1",
	"tier-info-user",
	"tier-cal-user",
	"tier-obj-user",
	"tier-set-user",
];

function request(
	method: string,
	path: string,
	opts: { body?: string; headers?: Record<string, string> } = {},
) {
	return SELF.fetch(`http://localhost${path}`, {
		method,
		headers: {
			Authorization: AUTH,
			...opts.headers,
		},
		body: opts.body,
		redirect: "manual",
	});
}

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

function mkcalendarBody(name: string, componentType: string = "VTODO"): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:set>
    <D:prop>
      <D:displayname>${name}</D:displayname>
      <C:supported-calendar-component-set>
        <C:comp name="${componentType}"/>
      </C:supported-calendar-component-set>
    </D:prop>
  </D:set>
</C:mkcalendar>`;
}

async function ensureUser(userId: string): Promise<void> {
	await env.DB.prepare(
		'INSERT OR IGNORE INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, datetime(\'now\'), datetime(\'now\'))',
	)
		.bind(userId, userId, `${userId}@test.com`)
		.run();
}

async function seedCalendar(
	name: string,
	componentType: string = "VTODO",
	userId: string = USER_ID,
): Promise<number> {
	await env.DB.prepare(
		"INSERT INTO calendars (user_id, name, component_type) VALUES (?, ?, ?)",
	)
		.bind(userId, name, componentType)
		.run();
	const row = await env.DB.prepare(
		"SELECT id FROM calendars WHERE user_id = ? ORDER BY id DESC LIMIT 1",
	)
		.bind(userId)
		.first<{ id: number }>();
	return row!.id;
}

async function seedObjects(
	calendarId: number,
	count: number,
): Promise<void> {
	for (let i = 0; i < count; i++) {
		const uid = `tier-obj-${calendarId}-${i}`;
		const etag = `"etag-${uid}"`;
		const icsData = makeVtodo(uid, `Task ${i}`);
		await env.DB.prepare(
			"INSERT INTO calendar_objects (calendar_id, uid, etag, ics_data) VALUES (?, ?, ?, ?)",
		)
			.bind(calendarId, uid, etag, icsData)
			.run();
	}
}

// Seed user rows for FK constraints (once)
beforeAll(async () => {
	for (const userId of TIER_TEST_USERS) {
		await ensureUser(userId);
	}
});

// Clean up tier-test data before each test
beforeEach(async () => {
	await env.DB.prepare("DELETE FROM user_tiers WHERE user_id LIKE 'tier-%' OR user_id = ?")
		.bind(USER_ID)
		.run();
	await env.DB.prepare("DELETE FROM calendar_objects WHERE calendar_id IN (SELECT id FROM calendars WHERE user_id LIKE 'tier-%' OR user_id = ?)")
		.bind(USER_ID)
		.run();
	await env.DB.prepare("DELETE FROM calendars WHERE user_id LIKE 'tier-%' OR user_id = ?")
		.bind(USER_ID)
		.run();
});

// === getUserTier ===

describe("getUserTier", () => {
	it("returns 'free' by default when no row exists", async () => {
		const tier = await getUserTier(env.DB, "tier-user-1");
		expect(tier).toBe("free");
	});

	it("returns the stored tier", async () => {
		await setUserTier(env.DB, "tier-user-1", "pro");
		const tier = await getUserTier(env.DB, "tier-user-1");
		expect(tier).toBe("pro");
	});
});

// === getUserTierInfo ===

describe("getUserTierInfo", () => {
	it("returns free tier limits by default", async () => {
		const info = await getUserTierInfo(env.DB, "tier-info-user");
		expect(info.tier).toBe("free");
		expect(info.limits).toEqual(TIER_LIMITS.free);
		expect(info.stripeCustomerId).toBeNull();
		expect(info.stripeSubscriptionId).toBeNull();
	});

	it("returns pro tier limits when set", async () => {
		await setUserTier(env.DB, "tier-info-user", "pro", "cus_123", "sub_456");
		const info = await getUserTierInfo(env.DB, "tier-info-user");
		expect(info.tier).toBe("pro");
		expect(info.limits).toEqual(TIER_LIMITS.pro);
		expect(info.stripeCustomerId).toBe("cus_123");
		expect(info.stripeSubscriptionId).toBe("sub_456");
	});
});

// === checkCalendarLimit ===

describe("checkCalendarLimit", () => {
	it("allows creating calendars under the free limit (3)", async () => {
		await seedCalendar("Cal 1", "VTODO", "tier-cal-user");
		await seedCalendar("Cal 2", "VTODO", "tier-cal-user");
		const allowed = await checkCalendarLimit(env.DB, "tier-cal-user");
		expect(allowed).toBe(true);
	});

	it("rejects creating a 4th calendar on free tier", async () => {
		await seedCalendar("Cal 1", "VTODO", "tier-cal-user");
		await seedCalendar("Cal 2", "VTODO", "tier-cal-user");
		await seedCalendar("Cal 3", "VTODO", "tier-cal-user");
		const allowed = await checkCalendarLimit(env.DB, "tier-cal-user");
		expect(allowed).toBe(false);
	});

	it("allows unlimited calendars on pro tier", async () => {
		await setUserTier(env.DB, "tier-cal-user", "pro");
		for (let i = 0; i < 5; i++) {
			await seedCalendar(`Cal ${i}`, "VTODO", "tier-cal-user");
		}
		const allowed = await checkCalendarLimit(env.DB, "tier-cal-user");
		expect(allowed).toBe(true);
	});
});

// === checkObjectLimit ===

describe("checkObjectLimit", () => {
	it("allows adding objects under the free limit (100)", async () => {
		const calId = await seedCalendar("ObjCal", "VTODO", "tier-obj-user");
		await seedObjects(calId, 50);
		const allowed = await checkObjectLimit(env.DB, "tier-obj-user", calId);
		expect(allowed).toBe(true);
	});

	it("rejects adding object at 100 on free tier", async () => {
		const calId = await seedCalendar("ObjCal", "VTODO", "tier-obj-user");
		await seedObjects(calId, 100);
		const allowed = await checkObjectLimit(env.DB, "tier-obj-user", calId);
		expect(allowed).toBe(false);
	});

	it("allows unlimited objects on pro tier", async () => {
		await setUserTier(env.DB, "tier-obj-user", "pro");
		const calId = await seedCalendar("ObjCal", "VTODO", "tier-obj-user");
		await seedObjects(calId, 100);
		const allowed = await checkObjectLimit(env.DB, "tier-obj-user", calId);
		expect(allowed).toBe(true);
	});
});

// === CalDAV 507 responses ===

describe("CalDAV tier limits (507 Insufficient Storage)", () => {
	it("returns 507 when creating a 4th calendar via MKCALENDAR", async () => {
		// Seed 3 calendars for the default user
		await seedCalendar("Cal A");
		await seedCalendar("Cal B");
		await seedCalendar("Cal C");

		const res = await request("POST", "/dav/projects/new-cal", {
			body: mkcalendarBody("Cal D"),
			headers: {
				"Content-Type": "application/xml",
				"X-Caldav-Method": "MKCALENDAR",
			},
		});
		expect(res.status).toBe(507);
	});

	it("returns 507 when adding an object beyond the limit via PUT", async () => {
		const calId = await seedCalendar("LimitCal");
		// Seed exactly 100 objects
		await seedObjects(calId, 100);

		const res = await request("PUT", `/dav/projects/${calId}/new-todo-507.ics`, {
			body: makeVtodo("new-todo-507", "Over limit"),
			headers: { "Content-Type": "text/calendar" },
		});
		expect(res.status).toBe(507);
	});

	it("allows PUT for updating existing objects even at the limit", async () => {
		const calId = await seedCalendar("LimitCal2");
		await seedObjects(calId, 100);

		// Update an existing object (should succeed since it's not new)
		const existingUid = `tier-obj-${calId}-0`;
		const res = await request("PUT", `/dav/projects/${calId}/${existingUid}.ics`, {
			body: makeVtodo(existingUid, "Updated task"),
			headers: { "Content-Type": "text/calendar" },
		});
		expect(res.status).toBe(204);
	});
});

// === setUserTier ===

describe("setUserTier", () => {
	it("inserts a new tier row", async () => {
		await setUserTier(env.DB, "tier-set-user", "pro", "cus_x", "sub_y");
		const tier = await getUserTier(env.DB, "tier-set-user");
		expect(tier).toBe("pro");
	});

	it("updates an existing tier row (upsert)", async () => {
		await setUserTier(env.DB, "tier-set-user", "free");
		await setUserTier(env.DB, "tier-set-user", "pro");
		const tier = await getUserTier(env.DB, "tier-set-user");
		expect(tier).toBe("pro");
	});
});
