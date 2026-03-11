import { describe, it, expect } from "vitest";
import { extractUid, isValidComponent } from "../src/caldav/ical.js";

const VTODO_ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:test-uid-123
SUMMARY:Buy milk
END:VTODO
END:VCALENDAR`;

const VEVENT_ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:event-uid-456
SUMMARY:Meeting
DTSTART:20260315T100000Z
DTEND:20260315T110000Z
END:VEVENT
END:VCALENDAR`;

describe("extractUid", () => {
	it("extracts UID from VTODO", () => {
		expect(extractUid(VTODO_ICS)).toBe("test-uid-123");
	});

	it("extracts UID from VEVENT", () => {
		expect(extractUid(VEVENT_ICS)).toBe("event-uid-456");
	});

	it("returns null for ICS without UID", () => {
		const noUid = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
SUMMARY:No UID here
END:VTODO
END:VCALENDAR`;
		expect(extractUid(noUid)).toBeNull();
	});

	it("falls back to regex for malformed ICS", () => {
		// This is not valid iCal but has a UID line
		const malformed = `GARBAGE DATA
UID:regex-fallback-uid
MORE GARBAGE`;
		expect(extractUid(malformed)).toBe("regex-fallback-uid");
	});

	it("returns null for completely empty input", () => {
		expect(extractUid("")).toBeNull();
	});

	it("handles UID with email-style characters", () => {
		const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:task@example.com
SUMMARY:Test
END:VTODO
END:VCALENDAR`;
		expect(extractUid(ics)).toBe("task@example.com");
	});

	it("handles ICS with CRLF line endings", () => {
		const ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:crlf-uid\r\nSUMMARY:Test\r\nEND:VTODO\r\nEND:VCALENDAR";
		expect(extractUid(ics)).toBe("crlf-uid");
	});

	it("prefers VTODO over VEVENT when both exist", () => {
		const both = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:todo-first
SUMMARY:Todo
END:VTODO
BEGIN:VEVENT
UID:event-second
SUMMARY:Event
END:VEVENT
END:VCALENDAR`;
		expect(extractUid(both)).toBe("todo-first");
	});
});

describe("isValidComponent", () => {
	it("validates VTODO component", () => {
		expect(isValidComponent(VTODO_ICS, "VTODO")).toBe(true);
	});

	it("validates VEVENT component", () => {
		expect(isValidComponent(VEVENT_ICS, "VEVENT")).toBe(true);
	});

	it("rejects VEVENT when expecting VTODO", () => {
		expect(isValidComponent(VEVENT_ICS, "VTODO")).toBe(false);
	});

	it("rejects VTODO when expecting VEVENT", () => {
		expect(isValidComponent(VTODO_ICS, "VEVENT")).toBe(false);
	});

	it("returns false for invalid ICS", () => {
		expect(isValidComponent("not ics data", "VTODO")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(isValidComponent("", "VTODO")).toBe(false);
	});

	it("is case-insensitive for component type", () => {
		expect(isValidComponent(VTODO_ICS, "vtodo")).toBe(true);
		expect(isValidComponent(VEVENT_ICS, "vevent")).toBe(true);
	});
});
