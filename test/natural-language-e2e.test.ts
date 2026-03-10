import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import "../src/index.js";
import {
	executeAction,
} from "../src/ai/natural-language.js";
import { createCalendar, getObjectByUid } from "../src/caldav/storage.js";

const TEST_USER_ID = "default";

describe("Natural Language - executeAction edge cases", () => {
	let calendarId: number;

	beforeAll(async () => {
		const cal = await createCalendar(env.DB, TEST_USER_ID, "NL E2E Tasks", "VTODO");
		calendarId = cal.id;
	});

	it("creates a task with CRLF in summary and verifies ICS escaping", async () => {
		const result = await executeAction(env.DB, calendarId, {
			action: "create",
			summary: "Line one\r\nLine two",
		});
		expect(result.action).toBe("create");

		const uid = (result.data as { uid: string }).uid;
		const obj = await getObjectByUid(env.DB, calendarId, uid);
		expect(obj).not.toBeNull();
		// CRLF should be escaped to \\n in ICS property values
		expect(obj!.icsData).toContain("SUMMARY:Line one\\nLine two");
		// Should NOT contain a raw newline in the SUMMARY line
		expect(obj!.icsData).not.toMatch(/SUMMARY:.*\r?\nLine two/);
	});

	it("creates a task with semicolons and commas in summary (escaped)", async () => {
		const result = await executeAction(env.DB, calendarId, {
			action: "create",
			summary: "Meeting; with, special chars",
		});
		expect(result.action).toBe("create");

		const uid = (result.data as { uid: string }).uid;
		const obj = await getObjectByUid(env.DB, calendarId, uid);
		expect(obj!.icsData).toContain("SUMMARY:Meeting\\; with\\, special chars");
	});

	it("returns error when updating non-existent task", async () => {
		const result = await executeAction(env.DB, calendarId, {
			action: "update",
			uid: "completely-nonexistent-uid-99999",
			summary: "Will not work",
		});
		expect(result.action).toBe("error");
		expect(result.message).toContain("not found");
	});

	it("search with empty results returns empty array", async () => {
		const result = await executeAction(env.DB, calendarId, {
			action: "search",
			query: "zzzzzzzz_impossible_match_99999",
		});
		expect(result.action).toBe("search");
		const tasks = (result.data as { tasks: unknown[] }).tasks;
		expect(tasks).toEqual([]);
	});

	it("creates a task with backslash in summary (escaped)", async () => {
		const result = await executeAction(env.DB, calendarId, {
			action: "create",
			summary: "Path: C:\\Users\\test",
		});
		expect(result.action).toBe("create");

		const uid = (result.data as { uid: string }).uid;
		const obj = await getObjectByUid(env.DB, calendarId, uid);
		// sanitizeIcsValue escapes each \ to \\
		// The ICS should contain the escaped backslashes
		const summaryLine = obj!.icsData.split("\n").find((l: string) => l.startsWith("SUMMARY:"));
		expect(summaryLine).toBeDefined();
		expect(summaryLine).toContain("C:\\\\");
	});

	it("handles create with missing summary by defaulting to Untitled", async () => {
		const result = await executeAction(env.DB, calendarId, {
			action: "create",
		});
		expect(result.action).toBe("create");

		const uid = (result.data as { uid: string }).uid;
		const obj = await getObjectByUid(env.DB, calendarId, uid);
		expect(obj!.icsData).toContain("SUMMARY:Untitled");
	});

	it("handles create with description containing newlines", async () => {
		const result = await executeAction(env.DB, calendarId, {
			action: "create",
			summary: "Described task",
			description: "First line\nSecond line",
		});
		expect(result.action).toBe("create");

		const uid = (result.data as { uid: string }).uid;
		const obj = await getObjectByUid(env.DB, calendarId, uid);
		expect(obj!.icsData).toContain("DESCRIPTION:First line\\nSecond line");
	});

	it("handles priority 0 (falsy value defaults to 5 then clamped)", async () => {
		const result = await executeAction(env.DB, calendarId, {
			action: "create",
			summary: "High priority",
			priority: 0,
		});
		expect(result.action).toBe("create");
		const uid = (result.data as { uid: string }).uid;
		const obj = await getObjectByUid(env.DB, calendarId, uid);
		// Number(0) || 5 evaluates to 5 because 0 is falsy, then clamped to [1,9] → 5
		expect(obj!.icsData).toContain("PRIORITY:5");
	});

	it("handles priority clamping above 9", async () => {
		const result = await executeAction(env.DB, calendarId, {
			action: "create",
			summary: "Low priority",
			priority: 15,
		});
		expect(result.action).toBe("create");
		const uid = (result.data as { uid: string }).uid;
		const obj = await getObjectByUid(env.DB, calendarId, uid);
		// priority 15 should be clamped to 9 (Math.min(9, ...))
		expect(obj!.icsData).toContain("PRIORITY:9");
	});
});
