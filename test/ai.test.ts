import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import "../src/index.js";
import {
	parseAiResponse,
	executeAction,
	buildSystemPrompt,
} from "../src/ai/natural-language.js";
import { createCalendar, putObject, getObjectByUid } from "../src/caldav/storage.js";

const TEST_USER_ID = "default";

describe("Natural Language - parseAiResponse", () => {
	it("parses plain JSON", () => {
		const result = parseAiResponse('{"action":"create","summary":"Buy milk"}');
		expect(result).toEqual({ action: "create", summary: "Buy milk" });
	});

	it("parses JSON from markdown code block", () => {
		const result = parseAiResponse(
			'Here is the result:\n```json\n{"action":"list"}\n```',
		);
		expect(result).toEqual({ action: "list" });
	});

	it("extracts JSON with surrounding text", () => {
		const result = parseAiResponse(
			'I will create a task. {"action":"create","summary":"Test"} Done!',
		);
		expect(result).toEqual({ action: "create", summary: "Test" });
	});

	it("returns null for non-JSON response", () => {
		const result = parseAiResponse("I cannot do that.");
		expect(result).toBeNull();
	});

	it("returns null for invalid JSON", () => {
		const result = parseAiResponse("{action: create}");
		expect(result).toBeNull();
	});

	it("returns null for empty string", () => {
		const result = parseAiResponse("");
		expect(result).toBeNull();
	});
});

describe("Natural Language - buildSystemPrompt", () => {
	it("includes existing tasks in the prompt", () => {
		const tasks = [
			{ uid: "abc-123", summary: "Buy groceries", status: "NEEDS-ACTION", due: "20260315" },
		];
		const prompt = buildSystemPrompt(tasks);
		expect(prompt).toContain("Buy groceries");
		expect(prompt).toContain("abc-123");
		expect(prompt).toContain("NEEDS-ACTION");
	});

	it("includes action format descriptions", () => {
		const prompt = buildSystemPrompt([]);
		expect(prompt).toContain('"action":"create"');
		expect(prompt).toContain('"action":"complete"');
		expect(prompt).toContain('"action":"delete"');
		expect(prompt).toContain('"action":"update"');
		expect(prompt).toContain('"action":"list"');
		expect(prompt).toContain('"action":"search"');
	});
});

describe("Natural Language - executeAction", () => {
	let calendarId: number;

	beforeAll(async () => {
		const cal = await createCalendar(env.DB, TEST_USER_ID, "AI Test Tasks", "VTODO");
		calendarId = cal.id;
	});

	it("creates a task", async () => {
		const result = await executeAction(env.DB, calendarId, {
			action: "create",
			summary: "AI created task",
			due: "20260315",
			priority: 1,
			description: "Created by AI test",
		});
		expect(result.action).toBe("create");
		expect(result.message).toContain("AI created task");
		expect(result.data).toHaveProperty("uid");

		// Verify it was stored
		const uid = (result.data as { uid: string }).uid;
		const obj = await getObjectByUid(env.DB, calendarId, uid);
		expect(obj).not.toBeNull();
		expect(obj!.icsData).toContain("SUMMARY:AI created task");
		expect(obj!.icsData).toContain("DUE:20260315");
		expect(obj!.icsData).toContain("PRIORITY:1");
		expect(obj!.icsData).toContain("DESCRIPTION:Created by AI test");
	});

	it("creates a task with minimal fields", async () => {
		const result = await executeAction(env.DB, calendarId, {
			action: "create",
			summary: "Minimal task",
		});
		expect(result.action).toBe("create");
		const uid = (result.data as { uid: string }).uid;
		const obj = await getObjectByUid(env.DB, calendarId, uid);
		expect(obj!.icsData).toContain("SUMMARY:Minimal task");
		expect(obj!.icsData).toContain("STATUS:NEEDS-ACTION");
		expect(obj!.icsData).not.toContain("DUE:");
		expect(obj!.icsData).not.toContain("PRIORITY:");
	});

	it("completes a task", async () => {
		// First create a task
		const createResult = await executeAction(env.DB, calendarId, {
			action: "create",
			summary: "Task to complete",
		});
		const uid = (createResult.data as { uid: string }).uid;

		// Complete it
		const result = await executeAction(env.DB, calendarId, {
			action: "complete",
			uid,
		});
		expect(result.action).toBe("complete");
		expect(result.message).toContain(uid);

		const obj = await getObjectByUid(env.DB, calendarId, uid);
		expect(obj!.icsData).toContain("STATUS:COMPLETED");
		expect(obj!.icsData).toContain("COMPLETED:");
	});

	it("returns error for completing non-existent task", async () => {
		const result = await executeAction(env.DB, calendarId, {
			action: "complete",
			uid: "non-existent-uid",
		});
		expect(result.action).toBe("error");
		expect(result.message).toContain("not found");
	});

	it("deletes a task", async () => {
		const createResult = await executeAction(env.DB, calendarId, {
			action: "create",
			summary: "Task to delete",
		});
		const uid = (createResult.data as { uid: string }).uid;

		const result = await executeAction(env.DB, calendarId, {
			action: "delete",
			uid,
		});
		expect(result.action).toBe("delete");

		const obj = await getObjectByUid(env.DB, calendarId, uid);
		expect(obj).toBeNull();
	});

	it("returns error for deleting non-existent task", async () => {
		const result = await executeAction(env.DB, calendarId, {
			action: "delete",
			uid: "non-existent-uid",
		});
		expect(result.action).toBe("error");
		expect(result.message).toContain("not found");
	});

	it("updates a task", async () => {
		const createResult = await executeAction(env.DB, calendarId, {
			action: "create",
			summary: "Original title",
		});
		const uid = (createResult.data as { uid: string }).uid;

		const result = await executeAction(env.DB, calendarId, {
			action: "update",
			uid,
			summary: "Updated title",
			due: "20260401",
			status: "IN-PROCESS",
		});
		expect(result.action).toBe("update");

		const obj = await getObjectByUid(env.DB, calendarId, uid);
		expect(obj!.icsData).toContain("SUMMARY:Updated title");
		expect(obj!.icsData).toContain("DUE:20260401");
		expect(obj!.icsData).toContain("STATUS:IN-PROCESS");
	});

	it("updates a task to COMPLETED status", async () => {
		const createResult = await executeAction(env.DB, calendarId, {
			action: "create",
			summary: "Update to complete",
		});
		const uid = (createResult.data as { uid: string }).uid;

		await executeAction(env.DB, calendarId, {
			action: "update",
			uid,
			status: "COMPLETED",
		});

		const obj = await getObjectByUid(env.DB, calendarId, uid);
		expect(obj!.icsData).toContain("STATUS:COMPLETED");
		expect(obj!.icsData).toContain("COMPLETED:");
	});

	it("returns error for updating non-existent task", async () => {
		const result = await executeAction(env.DB, calendarId, {
			action: "update",
			uid: "non-existent-uid",
			summary: "Won't work",
		});
		expect(result.action).toBe("error");
		expect(result.message).toContain("not found");
	});

	it("lists tasks", async () => {
		// Create a known task
		await executeAction(env.DB, calendarId, {
			action: "create",
			summary: "Listed task",
		});

		const result = await executeAction(env.DB, calendarId, {
			action: "list",
		});
		expect(result.action).toBe("list");
		expect(result.message).toContain("task(s)");
		const tasks = (result.data as { tasks: unknown[] }).tasks;
		expect(tasks.length).toBeGreaterThan(0);
	});

	it("searches tasks by keyword", async () => {
		await executeAction(env.DB, calendarId, {
			action: "create",
			summary: "Unique searchable keyword xyz",
		});

		const result = await executeAction(env.DB, calendarId, {
			action: "search",
			query: "xyz",
		});
		expect(result.action).toBe("search");
		const tasks = (result.data as { tasks: unknown[] }).tasks;
		expect(tasks.length).toBeGreaterThanOrEqual(1);
	});

	it("search returns empty for no matches", async () => {
		const result = await executeAction(env.DB, calendarId, {
			action: "search",
			query: "nonexistentquery99999",
		});
		expect(result.action).toBe("search");
		const tasks = (result.data as { tasks: unknown[] }).tasks;
		expect(tasks.length).toBe(0);
	});

	it("returns error for unknown action", async () => {
		const result = await executeAction(env.DB, calendarId, {
			action: "fly_to_moon",
		});
		expect(result.action).toBe("error");
		expect(result.message).toContain("Unknown action");
	});
});
