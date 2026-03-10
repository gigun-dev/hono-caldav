import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	getCalendarsForUser,
	getCalendarById,
	getObjectsForCalendar,
	getObjectByUid,
	putObject,
	deleteObject,
} from "../caldav/storage.js";

/**
 * Create an MCP server instance with CalDAV tools.
 * Each tool directly calls storage.ts, bypassing XML/CalDAV overhead.
 */
export function createMcpServer(db: D1Database, userId: string) {
	const server = new McpServer({
		name: "hono-caldav",
		version: "1.0.0",
	});

	// --- Calendar tools ---

	server.tool(
		"list_calendars",
		"List all calendars for the current user",
		{},
		async () => {
			const calendars = await getCalendarsForUser(db, userId);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							calendars.map((c) => ({
								id: c.id,
								name: c.name,
								componentType: c.componentType,
								synctoken: c.synctoken,
							})),
							null,
							2,
						),
					},
				],
			};
		},
	);

	// --- Task tools ---

	server.tool(
		"list_tasks",
		"List all tasks in a calendar with parsed metadata",
		{ calendarId: z.number().describe("Calendar ID") },
		async ({ calendarId }) => {
			const cal = await getCalendarById(db, userId, calendarId);
			if (!cal) {
				return {
					content: [{ type: "text", text: "Calendar not found" }],
					isError: true,
				};
			}
			const objects = await getObjectsForCalendar(db, calendarId);
			const tasks = objects.map((o) => parseTaskFromIcs(o.uid, o.icsData));
			return {
				content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }],
			};
		},
	);

	server.tool(
		"get_task",
		"Get a single task by UID",
		{
			calendarId: z.number().describe("Calendar ID"),
			uid: z.string().describe("Task UID"),
		},
		async ({ calendarId, uid }) => {
			const obj = await getObjectByUid(db, calendarId, uid);
			if (!obj) {
				return {
					content: [{ type: "text", text: "Task not found" }],
					isError: true,
				};
			}
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(parseTaskFromIcs(obj.uid, obj.icsData), null, 2),
					},
				],
			};
		},
	);

	server.tool(
		"create_task",
		"Create a new VTODO task",
		{
			calendarId: z.number().describe("Calendar ID"),
			summary: z.string().describe("Task title"),
			due: z
				.string()
				.optional()
				.describe("Due date (YYYYMMDD or YYYYMMDDTHHmmssZ)"),
			priority: z.number().min(0).max(9).optional().describe("Priority (1=high, 9=low)"),
			description: z.string().optional().describe("Task description"),
		},
		async ({ calendarId, summary, due, priority, description }) => {
			const cal = await getCalendarById(db, userId, calendarId);
			if (!cal || cal.componentType !== "VTODO") {
				return {
					content: [{ type: "text", text: "VTODO calendar not found" }],
					isError: true,
				};
			}

			const uid = crypto.randomUUID();
			const now = formatTimestamp(new Date());
			const lines = [
				"BEGIN:VCALENDAR",
				"VERSION:2.0",
				"PRODID:-//hono-caldav//MCP//EN",
				"BEGIN:VTODO",
				`UID:${uid}`,
				`DTSTAMP:${now}`,
				`CREATED:${now}`,
				`SUMMARY:${summary}`,
				"STATUS:NEEDS-ACTION",
			];
			if (due) lines.push(`DUE:${due}`);
			if (priority !== undefined) lines.push(`PRIORITY:${priority}`);
			if (description) lines.push(`DESCRIPTION:${description}`);
			lines.push("END:VTODO", "END:VCALENDAR");

			await putObject(db, calendarId, uid, lines.join("\r\n") + "\r\n");
			return {
				content: [
					{
						type: "text",
						text: `Created task "${summary}" (UID: ${uid})`,
					},
				],
			};
		},
	);

	server.tool(
		"update_task",
		"Update an existing task's properties",
		{
			calendarId: z.number().describe("Calendar ID"),
			uid: z.string().describe("Task UID"),
			summary: z.string().optional().describe("New title"),
			due: z.string().optional().describe("New due date"),
			priority: z.number().min(0).max(9).optional().describe("New priority"),
			description: z.string().optional().describe("New description"),
			status: z
				.enum(["NEEDS-ACTION", "IN-PROCESS", "COMPLETED", "CANCELLED"])
				.optional()
				.describe("New status"),
		},
		async ({ calendarId, uid, summary, due, priority, description, status }) => {
			const obj = await getObjectByUid(db, calendarId, uid);
			if (!obj) {
				return {
					content: [{ type: "text", text: "Task not found" }],
					isError: true,
				};
			}

			let ics = obj.icsData;
			const now = formatTimestamp(new Date());

			if (summary !== undefined) {
				ics = replaceOrInsertProp(ics, "SUMMARY", summary);
			}
			if (due !== undefined) {
				ics = replaceOrInsertProp(ics, "DUE", due);
			}
			if (priority !== undefined) {
				ics = replaceOrInsertProp(ics, "PRIORITY", String(priority));
			}
			if (description !== undefined) {
				ics = replaceOrInsertProp(ics, "DESCRIPTION", description);
			}
			if (status !== undefined) {
				ics = replaceOrInsertProp(ics, "STATUS", status);
				if (status === "COMPLETED" && !ics.includes("COMPLETED:")) {
					ics = ics.replace("END:VTODO", `COMPLETED:${now}\r\nEND:VTODO`);
				}
			}
			ics = replaceOrInsertProp(ics, "LAST-MODIFIED", now);

			await putObject(db, calendarId, uid, ics);
			return {
				content: [{ type: "text", text: `Updated task ${uid}` }],
			};
		},
	);

	server.tool(
		"complete_task",
		"Mark a task as completed",
		{
			calendarId: z.number().describe("Calendar ID"),
			uid: z.string().describe("Task UID"),
		},
		async ({ calendarId, uid }) => {
			const obj = await getObjectByUid(db, calendarId, uid);
			if (!obj) {
				return {
					content: [{ type: "text", text: "Task not found" }],
					isError: true,
				};
			}

			const now = formatTimestamp(new Date());
			let ics = replaceOrInsertProp(obj.icsData, "STATUS", "COMPLETED");
			ics = replaceOrInsertProp(ics, "LAST-MODIFIED", now);
			if (!ics.includes("COMPLETED:")) {
				ics = ics.replace("END:VTODO", `COMPLETED:${now}\r\nEND:VTODO`);
			}

			await putObject(db, calendarId, uid, ics);
			return {
				content: [{ type: "text", text: `Completed task ${uid}` }],
			};
		},
	);

	server.tool(
		"delete_task",
		"Delete a task",
		{
			calendarId: z.number().describe("Calendar ID"),
			uid: z.string().describe("Task UID"),
		},
		async ({ calendarId, uid }) => {
			const deleted = await deleteObject(db, calendarId, uid);
			return {
				content: [
					{
						type: "text",
						text: deleted ? `Deleted task ${uid}` : "Task not found",
					},
				],
				isError: !deleted,
			};
		},
	);

	server.tool(
		"search_tasks",
		"Search tasks by keyword in summary/description",
		{
			calendarId: z.number().describe("Calendar ID"),
			query: z.string().describe("Search keyword"),
			status: z
				.enum(["NEEDS-ACTION", "IN-PROCESS", "COMPLETED", "CANCELLED"])
				.optional()
				.describe("Filter by status"),
		},
		async ({ calendarId, query, status }) => {
			const objects = await getObjectsForCalendar(db, calendarId);
			const tasks = objects
				.map((o) => parseTaskFromIcs(o.uid, o.icsData))
				.filter((t) => {
					const matchesQuery =
						t.summary.toLowerCase().includes(query.toLowerCase()) ||
						(t.description?.toLowerCase().includes(query.toLowerCase()) ?? false);
					const matchesStatus = status ? t.status === status : true;
					return matchesQuery && matchesStatus;
				});
			return {
				content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }],
			};
		},
	);

	return server;
}

// --- Helpers ---

function formatTimestamp(date: Date): string {
	return date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

function parseTaskFromIcs(
	uid: string,
	icsData: string,
): {
	uid: string;
	summary: string;
	status: string;
	due: string | null;
	priority: number | null;
	description: string | null;
	created: string | null;
	completed: string | null;
} {
	return {
		uid,
		summary: extractProp(icsData, "SUMMARY") ?? "Untitled",
		status: extractProp(icsData, "STATUS") ?? "NEEDS-ACTION",
		due: extractProp(icsData, "DUE") ?? null,
		priority: (() => {
			const p = extractProp(icsData, "PRIORITY");
			return p ? parseInt(p, 10) : null;
		})(),
		description: extractProp(icsData, "DESCRIPTION") ?? null,
		created: extractProp(icsData, "CREATED") ?? null,
		completed: extractProp(icsData, "COMPLETED") ?? null,
	};
}

function extractProp(ics: string, propName: string): string | null {
	const regex = new RegExp(`^${propName}[^:]*:(.+)$`, "im");
	const match = ics.match(regex);
	return match?.[1]?.trim() ?? null;
}

function replaceOrInsertProp(ics: string, propName: string, value: string): string {
	const regex = new RegExp(`^${propName}[^:]*:.*$`, "im");
	if (regex.test(ics)) {
		return ics.replace(regex, `${propName}:${value}`);
	}
	// Insert before END:VTODO
	return ics.replace("END:VTODO", `${propName}:${value}\r\nEND:VTODO`);
}
