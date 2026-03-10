import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import "../src/index.js";

const MCP_AUTH = "Bearer test-mcp-token";

function mcpRequest(method: string, params?: Record<string, unknown>, id = 1) {
	return SELF.fetch("http://localhost/mcp", {
		method: "POST",
		headers: {
			Authorization: MCP_AUTH,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
	});
}

describe("MCP Authentication", () => {
	it("returns 401 without token", async () => {
		const res = await SELF.fetch("http://localhost/mcp", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
		});
		expect(res.status).toBe(401);
	});

	it("returns 401 with wrong token", async () => {
		const res = await SELF.fetch("http://localhost/mcp", {
			method: "POST",
			headers: {
				Authorization: "Bearer wrong-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
		});
		expect(res.status).toBe(401);
	});
});

describe("MCP Protocol", () => {
	it("initialize returns server info", async () => {
		const res = await mcpRequest("initialize");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.result.serverInfo.name).toBe("hono-caldav");
		expect(body.result.capabilities.tools).toBeDefined();
	});

	it("tools/list returns all tools", async () => {
		const res = await mcpRequest("tools/list");
		const body = await res.json();
		const toolNames = body.result.tools.map((t: { name: string }) => t.name);
		expect(toolNames).toContain("list_calendars");
		expect(toolNames).toContain("create_task");
		expect(toolNames).toContain("complete_task");
		expect(toolNames).toContain("search_tasks");
	});

	it("ping returns empty result", async () => {
		const res = await mcpRequest("ping");
		const body = await res.json();
		expect(body.result).toEqual({});
	});

	it("unknown method returns error", async () => {
		const res = await mcpRequest("unknown/method");
		const body = await res.json();
		expect(body.error).toBeDefined();
		expect(body.error.code).toBe(-32601);
	});
});

describe("MCP Tools", () => {
	let calendarId: number;

	beforeAll(async () => {
		// Create a VTODO calendar for the default user
		await env.DB.prepare(
			"INSERT INTO calendars (user_id, name, component_type) VALUES (?, ?, ?)",
		)
			.bind("default", "MCP Test Calendar", "VTODO")
			.run();
		const row = await env.DB.prepare(
			"SELECT id FROM calendars WHERE user_id = ? ORDER BY id DESC LIMIT 1",
		)
			.bind("default")
			.first<{ id: number }>();
		calendarId = row!.id;
	});

	it("list_calendars returns calendars", async () => {
		const res = await mcpRequest("tools/call", {
			name: "list_calendars",
			arguments: {},
		});
		const body = await res.json();
		const calendars = JSON.parse(body.result.content[0].text);
		expect(calendars.length).toBeGreaterThan(0);
		expect(calendars[0].name).toBeDefined();
	});

	it("create_task creates a VTODO", async () => {
		const res = await mcpRequest("tools/call", {
			name: "create_task",
			arguments: {
				calendarId,
				summary: "MCP Created Task",
				due: "20260315T100000Z",
				priority: 1,
			},
		});
		const body = await res.json();
		expect(body.result.content[0].text).toContain("MCP Created Task");
		expect(body.result.content[0].text).toContain("UID:");
	});

	it("list_tasks shows created task", async () => {
		// Create a task in this test to ensure it exists
		await mcpRequest("tools/call", {
			name: "create_task",
			arguments: { calendarId, summary: "List Test Task" },
		});
		const res = await mcpRequest("tools/call", {
			name: "list_tasks",
			arguments: { calendarId },
		});
		const body = await res.json();
		const tasks = JSON.parse(body.result.content[0].text);
		expect(tasks.some((t: { summary: string }) => t.summary === "List Test Task")).toBe(true);
	});

	it("search_tasks finds task by keyword", async () => {
		// Create a task with a unique keyword
		await mcpRequest("tools/call", {
			name: "create_task",
			arguments: { calendarId, summary: "Searchable UniqueXYZ" },
		});
		const res = await mcpRequest("tools/call", {
			name: "search_tasks",
			arguments: { calendarId, query: "UniqueXYZ" },
		});
		const body = await res.json();
		const tasks = JSON.parse(body.result.content[0].text);
		expect(tasks.length).toBeGreaterThan(0);
		expect(tasks[0].summary).toContain("UniqueXYZ");
	});

	it("complete_task marks task as completed", async () => {
		// Create a task first
		const createRes = await mcpRequest("tools/call", {
			name: "create_task",
			arguments: { calendarId, summary: "To Complete" },
		});
		const createBody = await createRes.json();
		const uidMatch = createBody.result.content[0].text.match(/UID: (.+)\)/);
		const uid = uidMatch[1];

		// Complete it
		const completeRes = await mcpRequest("tools/call", {
			name: "complete_task",
			arguments: { calendarId, uid },
		});
		const completeBody = await completeRes.json();
		expect(completeBody.result.content[0].text).toContain("Completed");

		// Verify
		const getRes = await mcpRequest("tools/call", {
			name: "get_task",
			arguments: { calendarId, uid },
		});
		const getBody = await getRes.json();
		const task = JSON.parse(getBody.result.content[0].text);
		expect(task.status).toBe("COMPLETED");
	});

	it("delete_task removes task", async () => {
		// Create a task
		const createRes = await mcpRequest("tools/call", {
			name: "create_task",
			arguments: { calendarId, summary: "To Delete" },
		});
		const createBody = await createRes.json();
		const uidMatch = createBody.result.content[0].text.match(/UID: (.+)\)/);
		const uid = uidMatch[1];

		// Delete it
		const delRes = await mcpRequest("tools/call", {
			name: "delete_task",
			arguments: { calendarId, uid },
		});
		const delBody = await delRes.json();
		expect(delBody.result.content[0].text).toContain("Deleted");

		// Verify it's gone
		const getRes = await mcpRequest("tools/call", {
			name: "get_task",
			arguments: { calendarId, uid },
		});
		const getBody = await getRes.json();
		expect(getBody.result.isError).toBe(true);
	});
});
