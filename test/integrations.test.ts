import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import "../src/index.js";

import {
	parseGmailMessage,
	base64UrlDecode,
	type GmailMessageResponse,
} from "../src/integrations/gmail.js";
import {
	parseFreeBusyResponse,
	parseEventsListResponse,
	type FreeBusyResponse,
	type EventsListResponse,
} from "../src/integrations/google-calendar.js";
import { parseExtractedTasks } from "../src/integrations/gmail-worker.js";

// --- Gmail message parsing ---

describe("Gmail - base64UrlDecode", () => {
	it("decodes base64url-encoded string", () => {
		// "Hello, World!" in base64url
		const encoded = "SGVsbG8sIFdvcmxkIQ";
		expect(base64UrlDecode(encoded)).toBe("Hello, World!");
	});

	it("handles padding correctly", () => {
		// "test" in base64url
		const encoded = "dGVzdA";
		expect(base64UrlDecode(encoded)).toBe("test");
	});

	it("handles base64url special chars", () => {
		// String with + and / in standard base64 → - and _ in base64url
		const encoded = "PDw_Pz4-"; // "<<??>>"\
		expect(base64UrlDecode(encoded)).toBe("<<??>>");
	});
});

describe("Gmail - parseGmailMessage", () => {
	it("parses a plain text message", () => {
		const bodyText = btoa("Please review the PR by Friday.");
		const bodyB64url = bodyText.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

		const data: GmailMessageResponse = {
			id: "msg-123",
			threadId: "thread-456",
			payload: {
				mimeType: "text/plain",
				headers: [
					{ name: "Subject", value: "PR Review Needed" },
					{ name: "From", value: "alice@example.com" },
					{ name: "Date", value: "Mon, 10 Mar 2026 10:00:00 +0000" },
				],
				body: { data: bodyB64url, size: 30 },
			},
		};

		const result = parseGmailMessage(data);
		expect(result.id).toBe("msg-123");
		expect(result.subject).toBe("PR Review Needed");
		expect(result.from).toBe("alice@example.com");
		expect(result.date).toBe("Mon, 10 Mar 2026 10:00:00 +0000");
		expect(result.bodyText).toBe("Please review the PR by Friday.");
	});

	it("parses a multipart message", () => {
		const plainBody = btoa("Task: Deploy by EOD");
		const plainB64url = plainBody.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

		const data: GmailMessageResponse = {
			id: "msg-789",
			threadId: "thread-012",
			payload: {
				mimeType: "multipart/alternative",
				headers: [
					{ name: "Subject", value: "Deployment Reminder" },
					{ name: "From", value: "bob@example.com" },
					{ name: "Date", value: "Tue, 11 Mar 2026 14:00:00 +0000" },
				],
				body: { size: 0 },
				parts: [
					{
						mimeType: "text/plain",
						body: { data: plainB64url, size: 19 },
					},
					{
						mimeType: "text/html",
						body: {
							data: btoa("<p>Task: Deploy by EOD</p>")
								.replace(/\+/g, "-")
								.replace(/\//g, "_")
								.replace(/=+$/, ""),
							size: 30,
						},
					},
				],
			},
		};

		const result = parseGmailMessage(data);
		expect(result.subject).toBe("Deployment Reminder");
		expect(result.bodyText).toBe("Task: Deploy by EOD");
	});

	it("handles missing headers gracefully", () => {
		const data: GmailMessageResponse = {
			id: "msg-empty",
			threadId: "thread-empty",
			payload: {
				mimeType: "text/plain",
				headers: [],
				body: { size: 0 },
			},
		};

		const result = parseGmailMessage(data);
		expect(result.subject).toBe("");
		expect(result.from).toBe("");
		expect(result.bodyText).toBe("");
	});
});

// --- Google Calendar free/busy parsing ---

describe("Google Calendar - parseFreeBusyResponse", () => {
	it("parses busy slots", () => {
		const data: FreeBusyResponse = {
			kind: "calendar#freeBusy",
			timeMin: "2026-03-10T00:00:00Z",
			timeMax: "2026-03-10T23:59:59Z",
			calendars: {
				primary: {
					busy: [
						{
							start: "2026-03-10T09:00:00Z",
							end: "2026-03-10T10:00:00Z",
						},
						{
							start: "2026-03-10T14:00:00Z",
							end: "2026-03-10T15:30:00Z",
						},
					],
				},
			},
		};

		const slots = parseFreeBusyResponse(data, "primary");
		expect(slots).toHaveLength(2);
		expect(slots[0]).toEqual({
			start: "2026-03-10T09:00:00Z",
			end: "2026-03-10T10:00:00Z",
		});
		expect(slots[1]).toEqual({
			start: "2026-03-10T14:00:00Z",
			end: "2026-03-10T15:30:00Z",
		});
	});

	it("returns empty array for no busy slots", () => {
		const data: FreeBusyResponse = {
			kind: "calendar#freeBusy",
			timeMin: "2026-03-10T00:00:00Z",
			timeMax: "2026-03-10T23:59:59Z",
			calendars: {
				primary: {
					busy: [],
				},
			},
		};

		const slots = parseFreeBusyResponse(data, "primary");
		expect(slots).toHaveLength(0);
	});

	it("returns empty for unknown calendar ID", () => {
		const data: FreeBusyResponse = {
			kind: "calendar#freeBusy",
			timeMin: "2026-03-10T00:00:00Z",
			timeMax: "2026-03-10T23:59:59Z",
			calendars: {
				primary: {
					busy: [
						{
							start: "2026-03-10T09:00:00Z",
							end: "2026-03-10T10:00:00Z",
						},
					],
				},
			},
		};

		const slots = parseFreeBusyResponse(data, "nonexistent@gmail.com");
		expect(slots).toHaveLength(0);
	});
});

describe("Google Calendar - parseEventsListResponse", () => {
	it("parses events with dateTime", () => {
		const data: EventsListResponse = {
			kind: "calendar#events",
			items: [
				{
					id: "evt-1",
					summary: "Team Standup",
					start: { dateTime: "2026-03-10T09:00:00+09:00" },
					end: { dateTime: "2026-03-10T09:30:00+09:00" },
					status: "confirmed",
				},
				{
					id: "evt-2",
					summary: "Lunch",
					start: { dateTime: "2026-03-10T12:00:00+09:00" },
					end: { dateTime: "2026-03-10T13:00:00+09:00" },
					status: "confirmed",
				},
			],
		};

		const events = parseEventsListResponse(data);
		expect(events).toHaveLength(2);
		expect(events[0]!.summary).toBe("Team Standup");
		expect(events[0]!.start).toBe("2026-03-10T09:00:00+09:00");
	});

	it("parses all-day events (date only)", () => {
		const data: EventsListResponse = {
			kind: "calendar#events",
			items: [
				{
					id: "evt-allday",
					summary: "Holiday",
					start: { date: "2026-03-20" },
					end: { date: "2026-03-21" },
					status: "confirmed",
				},
			],
		};

		const events = parseEventsListResponse(data);
		expect(events).toHaveLength(1);
		expect(events[0]!.start).toBe("2026-03-20");
		expect(events[0]!.end).toBe("2026-03-21");
	});

	it("handles empty items", () => {
		const data: EventsListResponse = {
			kind: "calendar#events",
			items: [],
		};

		const events = parseEventsListResponse(data);
		expect(events).toHaveLength(0);
	});

	it("handles missing items", () => {
		const data: EventsListResponse = {
			kind: "calendar#events",
		};

		const events = parseEventsListResponse(data);
		expect(events).toHaveLength(0);
	});
});

// --- Gmail poll pipeline (AI task extraction parsing) ---

describe("Gmail Worker - parseExtractedTasks", () => {
	it("parses valid task array", () => {
		const aiResponse = JSON.stringify([
			{ summary: "Review PR #42", due: "20260312", priority: 1 },
			{ summary: "Update docs", description: "Add API section" },
		]);

		const tasks = parseExtractedTasks(aiResponse);
		expect(tasks).toHaveLength(2);
		expect(tasks[0]!.summary).toBe("Review PR #42");
		expect(tasks[0]!.due).toBe("20260312");
		expect(tasks[0]!.priority).toBe(1);
		expect(tasks[1]!.summary).toBe("Update docs");
		expect(tasks[1]!.description).toBe("Add API section");
	});

	it("returns empty array for empty AI response", () => {
		expect(parseExtractedTasks("[]")).toHaveLength(0);
	});

	it("returns empty for non-task response", () => {
		expect(
			parseExtractedTasks("No tasks found in this email."),
		).toHaveLength(0);
	});

	it("handles JSON wrapped in text", () => {
		const aiResponse =
			'Here are the tasks:\n[{"summary":"Buy groceries"}]\nDone!';
		const tasks = parseExtractedTasks(aiResponse);
		expect(tasks).toHaveLength(1);
		expect(tasks[0]!.summary).toBe("Buy groceries");
	});

	it("filters out items without summary", () => {
		const aiResponse = JSON.stringify([
			{ summary: "Valid task" },
			{ due: "20260312" }, // no summary
			{ summary: "Another task" },
		]);

		const tasks = parseExtractedTasks(aiResponse);
		expect(tasks).toHaveLength(2);
	});

	it("handles invalid JSON gracefully", () => {
		expect(parseExtractedTasks("[{invalid json}]")).toHaveLength(0);
	});
});
