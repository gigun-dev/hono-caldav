import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import "../src/index.js";
import {
	generateVeventIcs,
	generateItipRequest,
	parseItipReply,
	parseItipCounter,
} from "../src/scheduling/itip.js";
import {
	addAttendees,
	getAttendees,
	updatePartstat,
} from "../src/scheduling/storage.js";

// --- iTIP unit tests ---

describe("iTIP generation", () => {
	it("generates VEVENT with ORGANIZER and ATTENDEE", () => {
		const ics = generateVeventIcs({
			uid: "test-event-1",
			summary: "Team Meeting",
			dtstart: "20260315T100000Z",
			dtend: "20260315T110000Z",
			organizerEmail: "scheduling@test.com",
			attendees: [
				{ email: "alice@test.com", partstat: "NEEDS-ACTION", rsvp: true },
			],
		});

		expect(ics).toContain("ORGANIZER;CN=Scheduling:mailto:scheduling@test.com");
		expect(ics).toContain("ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:alice@test.com");
		expect(ics).toContain("SUMMARY:Team Meeting");
		expect(ics).not.toContain("METHOD:");
	});

	it("generates iTIP REQUEST with METHOD", () => {
		const ics = generateItipRequest({
			uid: "test-event-2",
			summary: "Standup",
			dtstart: "20260315T090000Z",
			dtend: "20260315T091500Z",
			organizerEmail: "scheduling@test.com",
			attendees: [
				{ email: "bob@test.com", partstat: "NEEDS-ACTION", rsvp: true },
			],
		});

		expect(ics).toContain("METHOD:REQUEST");
		expect(ics).toContain("SUMMARY:Standup");
	});
});

describe("iTIP parsing", () => {
	it("parses REPLY with PARTSTAT", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"METHOD:REPLY",
			"BEGIN:VEVENT",
			"UID:event-123",
			"ATTENDEE;PARTSTAT=ACCEPTED:mailto:alice@test.com",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");

		const reply = parseItipReply(ics);
		expect(reply).not.toBeNull();
		expect(reply!.uid).toBe("event-123");
		expect(reply!.attendeeEmail).toBe("alice@test.com");
		expect(reply!.partstat).toBe("ACCEPTED");
		expect(reply!.method).toBe("REPLY");
	});

	it("parses COUNTER with new times", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"METHOD:COUNTER",
			"BEGIN:VEVENT",
			"UID:event-456",
			"DTSTART:20260316T140000Z",
			"DTEND:20260316T150000Z",
			"ATTENDEE;PARTSTAT=TENTATIVE:mailto:bob@test.com",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");

		const counter = parseItipCounter(ics);
		expect(counter).not.toBeNull();
		expect(counter!.uid).toBe("event-456");
		expect(counter!.newDtstart).toBe("20260316T140000Z");
		expect(counter!.newDtend).toBe("20260316T150000Z");
		expect(counter!.attendeeEmail).toBe("bob@test.com");
	});

	it("returns null for non-COUNTER", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"METHOD:REQUEST",
			"BEGIN:VEVENT",
			"UID:x",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");
		expect(parseItipCounter(ics)).toBeNull();
	});
});

// --- Attendee storage tests ---

describe("Attendee storage", () => {
	let objectId: number;

	beforeAll(async () => {
		// Create a calendar and object for testing
		await env.DB.prepare(
			"INSERT INTO calendars (user_id, name, component_type) VALUES (?, ?, ?)",
		)
			.bind("default", "Scheduling Cal", "VEVENT")
			.run();
		const cal = await env.DB.prepare(
			"SELECT id FROM calendars WHERE user_id = ? ORDER BY id DESC LIMIT 1",
		)
			.bind("default")
			.first<{ id: number }>();

		await env.DB.prepare(
			"INSERT INTO calendar_objects (calendar_id, uid, etag, ics_data) VALUES (?, ?, ?, ?)",
		)
			.bind(cal!.id, "sched-test-1", '"abc"', "BEGIN:VCALENDAR\r\nEND:VCALENDAR")
			.run();
		const obj = await env.DB.prepare(
			"SELECT id FROM calendar_objects WHERE uid = ?",
		)
			.bind("sched-test-1")
			.first<{ id: number }>();
		objectId = obj!.id;
	});

	it("adds and retrieves attendees", async () => {
		await addAttendees(env.DB, objectId, [
			{ email: "alice@test.com" },
			{ email: "bob@test.com", partstat: "ACCEPTED" },
		]);

		const attendees = await getAttendees(env.DB, objectId);
		expect(attendees.length).toBe(2);
		expect(attendees.find((a) => a.email === "alice@test.com")?.partstat).toBe(
			"NEEDS-ACTION",
		);
		expect(attendees.find((a) => a.email === "bob@test.com")?.partstat).toBe(
			"ACCEPTED",
		);
	});

	it("updates PARTSTAT", async () => {
		// Add a fresh attendee for this specific test
		await addAttendees(env.DB, objectId, [
			{ email: "update-test@test.com" },
		]);

		const updated = await updatePartstat(
			env.DB,
			objectId,
			"update-test@test.com",
			"DECLINED",
		);
		expect(updated).toBe(true);

		const attendees = await getAttendees(env.DB, objectId);
		expect(attendees.find((a) => a.email === "update-test@test.com")?.partstat).toBe(
			"DECLINED",
		);
		expect(
			attendees.find((a) => a.email === "update-test@test.com")?.repliedAt,
		).not.toBeNull();
	});
});

// --- Scheduling API integration tests ---

describe("Scheduling API", () => {
	const AUTH = "Basic " + btoa("test-user:test-pass");
	let calendarId: number;

	beforeAll(async () => {
		await env.DB.prepare(
			"INSERT INTO calendars (user_id, name, component_type) VALUES (?, ?, ?)",
		)
			.bind("default", "Events Cal", "VEVENT")
			.run();
		const row = await env.DB.prepare(
			"SELECT id FROM calendars WHERE user_id = ? AND name = ? ORDER BY id DESC LIMIT 1",
		)
			.bind("default", "Events Cal")
			.first<{ id: number }>();
		calendarId = row!.id;
	});

	it("processes iTIP REPLY and updates PARTSTAT", async () => {
		// First create an event with attendees via direct DB insert
		const uid = "reply-test-" + crypto.randomUUID().slice(0, 8);
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"BEGIN:VEVENT",
			`UID:${uid}`,
			"DTSTAMP:20260315T000000Z",
			"DTSTART:20260315T100000Z",
			"DTEND:20260315T110000Z",
			"SUMMARY:Reply Test Event",
			"ORGANIZER:mailto:scheduling@test.com",
			"ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:responder@test.com",
			"SEQUENCE:0",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");

		await env.DB.prepare(
			"INSERT INTO calendar_objects (calendar_id, uid, etag, ics_data) VALUES (?, ?, ?, ?)",
		)
			.bind(calendarId, uid, '"test"', ics)
			.run();

		const obj = await env.DB.prepare(
			"SELECT id FROM calendar_objects WHERE uid = ?",
		)
			.bind(uid)
			.first<{ id: number }>();

		await addAttendees(env.DB, obj!.id, [{ email: "responder@test.com" }]);

		// Send REPLY
		const replyIcs = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"METHOD:REPLY",
			"BEGIN:VEVENT",
			`UID:${uid}`,
			"ATTENDEE;PARTSTAT=ACCEPTED:mailto:responder@test.com",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");

		const res = await SELF.fetch("http://localhost/api/scheduling/reply", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ icsData: replyIcs }),
		});

		expect(res.status).toBe(200);
		const body = await res.json() as { partstat: string };
		expect(body.partstat).toBe("ACCEPTED");

		// Verify attendee record updated
		const attendees = await getAttendees(env.DB, obj!.id);
		expect(attendees[0].partstat).toBe("ACCEPTED");
	});

	it("processes iTIP COUNTER with auto-accept", async () => {
		const uid = "counter-test-" + crypto.randomUUID().slice(0, 8);
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"BEGIN:VEVENT",
			`UID:${uid}`,
			"DTSTAMP:20260315T000000Z",
			"DTSTART:20260315T100000Z",
			"DTEND:20260315T110000Z",
			"SUMMARY:Counter Test Event",
			"ORGANIZER:mailto:scheduling@test.com",
			"ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:proposer@test.com",
			"SEQUENCE:0",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");

		await env.DB.prepare(
			"INSERT INTO calendar_objects (calendar_id, uid, etag, ics_data) VALUES (?, ?, ?, ?)",
		)
			.bind(calendarId, uid, '"test"', ics)
			.run();

		const obj = await env.DB.prepare(
			"SELECT id FROM calendar_objects WHERE uid = ?",
		)
			.bind(uid)
			.first<{ id: number }>();

		await addAttendees(env.DB, obj!.id, [{ email: "proposer@test.com" }]);

		// Send COUNTER
		const counterIcs = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"METHOD:COUNTER",
			"BEGIN:VEVENT",
			`UID:${uid}`,
			"DTSTART:20260316T140000Z",
			"DTEND:20260316T150000Z",
			"ATTENDEE;PARTSTAT=TENTATIVE:mailto:proposer@test.com",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");

		const res = await SELF.fetch("http://localhost/api/scheduling/counter", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ icsData: counterIcs }),
		});

		expect(res.status).toBe(200);
		const body = await res.json() as {
			newDtstart: string;
			newDtend: string;
			sequence: number;
			itipRequest: string;
		};
		expect(body.newDtstart).toBe("20260316T140000Z");
		expect(body.newDtend).toBe("20260316T150000Z");
		expect(body.sequence).toBe(1);
		expect(body.itipRequest).toContain("METHOD:REQUEST");
	});
});
