import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import "../src/index.js";
import {
	shareCalendar,
	listShares,
	revokeShare,
	getSharedCalendars,
} from "../src/sharing/api.js";
import { getCalendarsForUser } from "../src/caldav/storage.js";

// --- Helpers ---

const OWNER_ID = "share-owner";
const RECIPIENT_ID = "share-recipient";

async function seedCalendar(
	userId: string,
	name: string,
	componentType: string = "VTODO",
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

async function cleanup() {
	await env.DB.prepare("DELETE FROM calendar_shares").run();
	await env.DB.prepare("DELETE FROM calendar_objects").run();
	await env.DB.prepare("DELETE FROM calendarchanges").run();
	await env.DB.prepare(
		"DELETE FROM calendars WHERE user_id IN (?, ?)",
	)
		.bind(OWNER_ID, RECIPIENT_ID)
		.run();
}

// === Share CRUD ===

describe("Calendar Sharing", () => {
	let calendarId: number;

	beforeEach(async () => {
		await cleanup();
		calendarId = await seedCalendar(OWNER_ID, "Shared Tasks");
	});

	it("shares a calendar and lists shares", async () => {
		const share = await shareCalendar(
			env.DB,
			OWNER_ID,
			calendarId,
			RECIPIENT_ID,
			"read",
		);
		expect(share).not.toBeNull();
		expect(share!.calendarId).toBe(calendarId);
		expect(share!.ownerId).toBe(OWNER_ID);
		expect(share!.sharedWith).toBe(RECIPIENT_ID);
		expect(share!.permission).toBe("read");

		const shares = await listShares(env.DB, calendarId, OWNER_ID);
		expect(shares).toHaveLength(1);
		expect(shares[0]!.id).toBe(share!.id);
	});

	it("revokes a share", async () => {
		const share = await shareCalendar(
			env.DB,
			OWNER_ID,
			calendarId,
			RECIPIENT_ID,
			"read",
		);
		expect(share).not.toBeNull();

		const revoked = await revokeShare(env.DB, share!.id, OWNER_ID);
		expect(revoked).toBe(true);

		const shares = await listShares(env.DB, calendarId, OWNER_ID);
		expect(shares).toHaveLength(0);
	});

	it("returns false when revoking non-existent share", async () => {
		const revoked = await revokeShare(env.DB, "nonexistent", OWNER_ID);
		expect(revoked).toBe(false);
	});

	it("shared calendars appear in recipient's calendar list", async () => {
		await shareCalendar(
			env.DB,
			OWNER_ID,
			calendarId,
			RECIPIENT_ID,
			"read",
		);

		// Without includeShared, recipient sees nothing
		const ownOnly = await getCalendarsForUser(env.DB, RECIPIENT_ID);
		expect(ownOnly).toHaveLength(0);

		// With includeShared, recipient sees the shared calendar
		const withShared = await getCalendarsForUser(
			env.DB,
			RECIPIENT_ID,
			true,
		);
		expect(withShared).toHaveLength(1);
		expect(withShared[0]!.id).toBe(calendarId);
		expect(withShared[0]!.name).toBe("Shared Tasks");
	});

	it("owner cannot share a calendar they don't own", async () => {
		const otherCalendar = await seedCalendar(
			RECIPIENT_ID,
			"Not Mine",
		);
		const share = await shareCalendar(
			env.DB,
			OWNER_ID,
			otherCalendar,
			"someone-else",
			"read",
		);
		expect(share).toBeNull();
	});

	it("rejects duplicate share (unique constraint)", async () => {
		await shareCalendar(
			env.DB,
			OWNER_ID,
			calendarId,
			RECIPIENT_ID,
			"read",
		);

		await expect(
			shareCalendar(
				env.DB,
				OWNER_ID,
				calendarId,
				RECIPIENT_ID,
				"read-write",
			),
		).rejects.toThrow();
	});

	it("getSharedCalendars returns calendar details", async () => {
		await shareCalendar(
			env.DB,
			OWNER_ID,
			calendarId,
			RECIPIENT_ID,
			"read",
		);

		const shared = await getSharedCalendars(env.DB, RECIPIENT_ID);
		expect(shared).toHaveLength(1);
		expect(shared[0]!.calendarId).toBe(calendarId);
		expect(shared[0]!.calendarName).toBe("Shared Tasks");
		expect(shared[0]!.permission).toBe("read");
	});

	it("non-owner cannot list shares", async () => {
		await shareCalendar(
			env.DB,
			OWNER_ID,
			calendarId,
			RECIPIENT_ID,
			"read",
		);

		// Different user tries to list shares
		const shares = await listShares(env.DB, calendarId, "other-user");
		expect(shares).toHaveLength(0);
	});

	it("non-owner cannot revoke shares", async () => {
		const share = await shareCalendar(
			env.DB,
			OWNER_ID,
			calendarId,
			RECIPIENT_ID,
			"read",
		);

		const revoked = await revokeShare(env.DB, share!.id, "other-user");
		expect(revoked).toBe(false);

		// Share should still exist
		const shares = await listShares(env.DB, calendarId, OWNER_ID);
		expect(shares).toHaveLength(1);
	});
});
