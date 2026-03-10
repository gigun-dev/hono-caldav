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
import { putObject } from "../src/caldav/storage.js";

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

// --- ICS line folding tests ---

describe("ICS line folding", () => {
	it("folds long SUMMARY lines at 75 octets", () => {
		const longSummary =
			"This is a very long event summary that exceeds seventy-five characters to test RFC 5545 line folding";
		const ics = generateVeventIcs({
			uid: "fold-test-1",
			summary: longSummary,
			dtstart: "20260315T100000Z",
			dtend: "20260315T110000Z",
			organizerEmail: "scheduling@test.com",
			attendees: [],
		});

		// Every physical line (split by CRLF) must be <= 75 octets
		const lines = ics.split("\r\n");
		for (const line of lines) {
			const octets = new TextEncoder().encode(line).length;
			expect(octets).toBeLessThanOrEqual(75);
		}

		// The content should still contain the full summary when unfolded
		const unfolded = ics.replace(/\r\n[ \t]/g, "");
		expect(unfolded).toContain(longSummary);
	});

	it("does not fold short lines", () => {
		const ics = generateVeventIcs({
			uid: "fold-test-2",
			summary: "Short",
			dtstart: "20260315T100000Z",
			dtend: "20260315T110000Z",
			organizerEmail: "a@b.com",
			attendees: [],
		});

		// No continuation lines (lines starting with space) for short content
		const lines = ics.split("\r\n");
		const summaryLine = lines.find((l) => l.startsWith("SUMMARY:"));
		expect(summaryLine).toBe("SUMMARY:Short");
	});

	it("folds long ATTENDEE lines with parameters", () => {
		const ics = generateVeventIcs({
			uid: "fold-test-3",
			summary: "Folding attendees",
			dtstart: "20260315T100000Z",
			dtend: "20260315T110000Z",
			organizerEmail: "scheduling@test.com",
			attendees: [
				{
					email: "a-very-long-email-address-for-testing@extremely-long-domain-name.example.com",
					partstat: "NEEDS-ACTION",
					rsvp: true,
				},
			],
		});

		const lines = ics.split("\r\n");
		for (const line of lines) {
			const octets = new TextEncoder().encode(line).length;
			expect(octets).toBeLessThanOrEqual(75);
		}

		// Unfolded should contain the full attendee
		const unfolded = ics.replace(/\r\n[ \t]/g, "");
		expect(unfolded).toContain(
			"mailto:a-very-long-email-address-for-testing@extremely-long-domain-name.example.com",
		);
	});

	it("handles empty lines and very short lines correctly", () => {
		// generateVeventIcs always produces non-empty lines, but foldIcsLines
		// should handle edge cases. We test via the output structure.
		const ics = generateVeventIcs({
			uid: "x",
			summary: "A",
			dtstart: "20260315T100000Z",
			dtend: "20260315T110000Z",
			organizerEmail: "a@b.com",
			attendees: [],
		});

		// Should still be valid ICS
		expect(ics).toContain("BEGIN:VCALENDAR");
		expect(ics).toContain("END:VCALENDAR");
		expect(ics).toContain("BEGIN:VEVENT");
		expect(ics).toContain("END:VEVENT");
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

// --- Scheduling API security edge cases ---

describe("Scheduling API - Security edge cases", () => {
	let calendarId: number;

	beforeAll(async () => {
		await env.DB.prepare(
			"INSERT INTO calendars (user_id, name, component_type) VALUES (?, ?, ?)",
		)
			.bind("default", "Security Test Cal", "VEVENT")
			.run();
		const row = await env.DB.prepare(
			"SELECT id FROM calendars WHERE user_id = ? AND name = ? ORDER BY id DESC LIMIT 1",
		)
			.bind("default", "Security Test Cal")
			.first<{ id: number }>();
		calendarId = row!.id;
	});

	it("rejects malformed ICS data in REPLY endpoint with 400", async () => {
		const res = await SELF.fetch("http://localhost/api/scheduling/reply", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ icsData: "not valid ics data at all" }),
		});
		expect(res.status).toBe(400);
		const body = await res.json() as { error: string };
		expect(body.error).toContain("Invalid");
	});

	it("rejects REPLY with non-existent UID with 404", async () => {
		const replyIcs = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"METHOD:REPLY",
			"BEGIN:VEVENT",
			"UID:totally-nonexistent-uid-12345",
			"ATTENDEE;PARTSTAT=ACCEPTED:mailto:nobody@test.com",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");

		const res = await SELF.fetch("http://localhost/api/scheduling/reply", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ icsData: replyIcs }),
		});
		expect(res.status).toBe(404);
		const body = await res.json() as { error: string };
		expect(body.error).toContain("not found");
	});

	it("rejects REPLY with attendee email not in the event with 404", async () => {
		const uid = "reply-no-attendee-" + crypto.randomUUID().slice(0, 8);
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"BEGIN:VEVENT",
			`UID:${uid}`,
			"DTSTAMP:20260315T000000Z",
			"DTSTART:20260315T100000Z",
			"DTEND:20260315T110000Z",
			"SUMMARY:Attendee Mismatch Test",
			"ORGANIZER:mailto:scheduling@test.com",
			"ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:registered@test.com",
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

		await addAttendees(env.DB, obj!.id, [{ email: "registered@test.com" }]);

		// Send REPLY with a different email than the registered attendee
		const replyIcs = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"METHOD:REPLY",
			"BEGIN:VEVENT",
			`UID:${uid}`,
			"ATTENDEE;PARTSTAT=ACCEPTED:mailto:stranger@test.com",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");

		const res = await SELF.fetch("http://localhost/api/scheduling/reply", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ icsData: replyIcs }),
		});
		expect(res.status).toBe(404);
		const body = await res.json() as { error: string };
		expect(body.error).toContain("Attendee not found");
	});

	it("rejects REPLY with invalid PARTSTAT value with 400", async () => {
		const uid = "reply-bad-partstat-" + crypto.randomUUID().slice(0, 8);
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"BEGIN:VEVENT",
			`UID:${uid}`,
			"DTSTAMP:20260315T000000Z",
			"DTSTART:20260315T100000Z",
			"DTEND:20260315T110000Z",
			"SUMMARY:Bad Partstat Test",
			"ORGANIZER:mailto:scheduling@test.com",
			"ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:bad@test.com",
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

		await addAttendees(env.DB, obj!.id, [{ email: "bad@test.com" }]);

		const replyIcs = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"METHOD:REPLY",
			"BEGIN:VEVENT",
			`UID:${uid}`,
			"ATTENDEE;PARTSTAT=INVALID_VALUE:mailto:bad@test.com",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");

		const res = await SELF.fetch("http://localhost/api/scheduling/reply", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ icsData: replyIcs }),
		});
		// parseItipReply validates PARTSTAT internally and returns null for invalid values,
		// so the handler returns "Invalid iTIP REPLY" rather than "Invalid PARTSTAT"
		expect(res.status).toBe(400);
		const body = await res.json() as { error: string };
		expect(body.error).toContain("Invalid");
	});

	it("processes COUNTER with same dtstart/dtend as original (no actual change)", async () => {
		const uid = "counter-nochange-" + crypto.randomUUID().slice(0, 8);
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"BEGIN:VEVENT",
			`UID:${uid}`,
			"DTSTAMP:20260315T000000Z",
			"DTSTART:20260315T100000Z",
			"DTEND:20260315T110000Z",
			"SUMMARY:No Change Counter Test",
			"ORGANIZER:mailto:scheduling@test.com",
			"ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:same@test.com",
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

		await addAttendees(env.DB, obj!.id, [{ email: "same@test.com" }]);

		// COUNTER with same times as original
		const counterIcs = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"METHOD:COUNTER",
			"BEGIN:VEVENT",
			`UID:${uid}`,
			"DTSTART:20260315T100000Z",
			"DTEND:20260315T110000Z",
			"ATTENDEE;PARTSTAT=TENTATIVE:mailto:same@test.com",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");

		const res = await SELF.fetch("http://localhost/api/scheduling/counter", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ icsData: counterIcs }),
		});

		// Should still succeed — auto-accept updates SEQUENCE even with same times
		expect(res.status).toBe(200);
		const body = await res.json() as {
			newDtstart: string;
			newDtend: string;
			sequence: number;
		};
		expect(body.newDtstart).toBe("20260315T100000Z");
		expect(body.newDtend).toBe("20260315T110000Z");
		expect(body.sequence).toBe(1);
	});

	it("rejects malformed ICS data in COUNTER endpoint with 400", async () => {
		const res = await SELF.fetch("http://localhost/api/scheduling/counter", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ icsData: "garbage data" }),
		});
		expect(res.status).toBe(400);
		const body = await res.json() as { error: string };
		expect(body.error).toContain("Invalid");
	});

	it("rejects COUNTER with non-existent UID with 404", async () => {
		const counterIcs = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"METHOD:COUNTER",
			"BEGIN:VEVENT",
			"UID:nonexistent-counter-uid-99999",
			"DTSTART:20260316T140000Z",
			"DTEND:20260316T150000Z",
			"ATTENDEE;PARTSTAT=TENTATIVE:mailto:nobody@test.com",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");

		const res = await SELF.fetch("http://localhost/api/scheduling/counter", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ icsData: counterIcs }),
		});
		expect(res.status).toBe(404);
		const body = await res.json() as { error: string };
		expect(body.error).toContain("not found");
	});
});

// --- createScheduledEvent integration test (via storage layer, since HTTP requires session auth) ---

describe("createScheduledEvent logic", () => {
	let calendarId: number;

	beforeAll(async () => {
		await env.DB.prepare(
			"INSERT INTO calendars (user_id, name, component_type) VALUES (?, ?, ?)",
		)
			.bind("default", "Create Event Cal", "VEVENT")
			.run();
		const row = await env.DB.prepare(
			"SELECT id FROM calendars WHERE user_id = ? AND name = ? ORDER BY id DESC LIMIT 1",
		)
			.bind("default", "Create Event Cal")
			.first<{ id: number }>();
		calendarId = row!.id;
	});

	it("creates event with attendees using storage layer and generates iTIP REQUEST", async () => {
		const uid = `test-event-${crypto.randomUUID().slice(0, 8)}@localhost`;

		const attendeeInfos = [
			{ email: "participant@test.com", partstat: "NEEDS-ACTION" as const, rsvp: true },
		];

		const eventInfo = {
			uid,
			summary: "Integration Test Meeting",
			dtstart: "20260320T100000Z",
			dtend: "20260320T110000Z",
			organizerEmail: "scheduling@test.com",
			attendees: attendeeInfos,
			sequence: 0,
		};

		// Store VEVENT
		const ics = generateVeventIcs(eventInfo);
		const { object } = await putObject(env.DB, calendarId, uid, ics);
		expect(object.id).toBeGreaterThan(0);

		// Store attendees
		await addAttendees(env.DB, object.id, [{ email: "participant@test.com" }]);

		// Generate iTIP REQUEST
		const itipRequest = generateItipRequest(eventInfo);
		expect(itipRequest).toContain("METHOD:REQUEST");
		expect(itipRequest).toContain("Integration Test Meeting");
		expect(itipRequest).toContain("mailto:participant@test.com");

		// Verify attendees stored
		const attendees = await getAttendees(env.DB, object.id);
		expect(attendees.length).toBe(1);
		expect(attendees[0].email).toBe("participant@test.com");
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
