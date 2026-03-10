/**
 * Lightweight MCP JSON-RPC handler for Cloudflare Workers.
 * Avoids @modelcontextprotocol/sdk dependency (ajv incompatible with workerd).
 * Implements Streamable HTTP transport directly.
 */

import {
	getCalendarsForUser,
	getCalendarById,
	getObjectsForCalendar,
	getObjectByUid,
	putObject,
	deleteObject,
} from "../caldav/storage.js";
import { pollGmailForTasks } from "../integrations/gmail-worker.js";
import { getFreeBusy } from "../integrations/google-calendar.js";
import { getValidAccessToken } from "../integrations/google-auth.js";

type JsonRpcRequest = {
	jsonrpc: "2.0";
	id?: string | number;
	method: string;
	params?: Record<string, unknown>;
};

type JsonRpcResponse = {
	jsonrpc: "2.0";
	id: string | number | null;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
};

type ToolDefinition = {
	name: string;
	description: string;
	inputSchema: {
		type: "object";
		properties: Record<string, unknown>;
		required?: string[];
	};
};

const TOOLS: ToolDefinition[] = [
	{
		name: "list_calendars",
		description: "List all calendars for the current user",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "list_tasks",
		description: "List all tasks in a calendar with parsed metadata",
		inputSchema: {
			type: "object",
			properties: {
				calendarId: { type: "number", description: "Calendar ID" },
			},
			required: ["calendarId"],
		},
	},
	{
		name: "get_task",
		description: "Get a single task by UID",
		inputSchema: {
			type: "object",
			properties: {
				calendarId: { type: "number", description: "Calendar ID" },
				uid: { type: "string", description: "Task UID" },
			},
			required: ["calendarId", "uid"],
		},
	},
	{
		name: "create_task",
		description: "Create a new VTODO task",
		inputSchema: {
			type: "object",
			properties: {
				calendarId: { type: "number", description: "Calendar ID" },
				summary: { type: "string", description: "Task title" },
				due: { type: "string", description: "Due date (YYYYMMDD or YYYYMMDDTHHmmssZ)" },
				priority: { type: "number", description: "Priority (1=high, 9=low)" },
				description: { type: "string", description: "Task description" },
			},
			required: ["calendarId", "summary"],
		},
	},
	{
		name: "update_task",
		description: "Update an existing task's properties",
		inputSchema: {
			type: "object",
			properties: {
				calendarId: { type: "number", description: "Calendar ID" },
				uid: { type: "string", description: "Task UID" },
				summary: { type: "string", description: "New title" },
				due: { type: "string", description: "New due date" },
				priority: { type: "number", description: "New priority" },
				description: { type: "string", description: "New description" },
				status: {
					type: "string",
					enum: ["NEEDS-ACTION", "IN-PROCESS", "COMPLETED", "CANCELLED"],
					description: "New status",
				},
			},
			required: ["calendarId", "uid"],
		},
	},
	{
		name: "complete_task",
		description: "Mark a task as completed",
		inputSchema: {
			type: "object",
			properties: {
				calendarId: { type: "number", description: "Calendar ID" },
				uid: { type: "string", description: "Task UID" },
			},
			required: ["calendarId", "uid"],
		},
	},
	{
		name: "delete_task",
		description: "Delete a task",
		inputSchema: {
			type: "object",
			properties: {
				calendarId: { type: "number", description: "Calendar ID" },
				uid: { type: "string", description: "Task UID" },
			},
			required: ["calendarId", "uid"],
		},
	},
	{
		name: "search_tasks",
		description: "Search tasks by keyword in summary/description",
		inputSchema: {
			type: "object",
			properties: {
				calendarId: { type: "number", description: "Calendar ID" },
				query: { type: "string", description: "Search keyword" },
				status: {
					type: "string",
					enum: ["NEEDS-ACTION", "IN-PROCESS", "COMPLETED", "CANCELLED"],
					description: "Filter by status",
				},
			},
			required: ["calendarId", "query"],
		},
	},
	{
		name: "poll_gmail",
		description:
			"Manually trigger a Gmail poll to extract tasks from recent emails",
		inputSchema: {
			type: "object",
			properties: {
				calendarId: {
					type: "number",
					description: "Target calendar ID for extracted tasks",
				},
			},
			required: ["calendarId"],
		},
	},
	{
		name: "check_calendar_availability",
		description:
			"Check free/busy availability on Google Calendar for a time range",
		inputSchema: {
			type: "object",
			properties: {
				calendarId: {
					type: "string",
					description:
						'Google Calendar ID (e.g., "primary" or email address)',
				},
				timeMin: {
					type: "string",
					description: "Start of time range (ISO format)",
				},
				timeMax: {
					type: "string",
					description: "End of time range (ISO format)",
				},
			},
			required: ["calendarId", "timeMin", "timeMax"],
		},
	},
];

export async function handleMcpRequest(
	request: Request,
	db: D1Database,
	userId: string,
	env?: CloudflareBindings,
): Promise<Response> {
	if (request.method === "GET") {
		// SSE endpoint - not needed for stateless mode
		return new Response("SSE not supported in stateless mode", { status: 405 });
	}

	if (request.method !== "POST") {
		return new Response("Method not allowed", { status: 405 });
	}

	let body: JsonRpcRequest | JsonRpcRequest[];
	try {
		body = await request.json();
	} catch {
		return jsonRpcError(null, -32700, "Parse error");
	}

	// Handle batch requests
	if (Array.isArray(body)) {
		const results = await Promise.all(
			body.map((req) => processRequest(req, db, userId, env)),
		);
		return new Response(JSON.stringify(results), {
			headers: { "Content-Type": "application/json" },
		});
	}

	const result = await processRequest(body, db, userId, env);
	// Notifications (no id) get no response
	if (body.id === undefined) {
		return new Response(null, { status: 202 });
	}
	return new Response(JSON.stringify(result), {
		headers: { "Content-Type": "application/json" },
	});
}

async function processRequest(
	req: JsonRpcRequest,
	db: D1Database,
	userId: string,
	env?: CloudflareBindings,
): Promise<JsonRpcResponse> {
	const id = req.id ?? null;

	switch (req.method) {
		case "initialize":
			return {
				jsonrpc: "2.0",
				id,
				result: {
					protocolVersion: "2025-03-26",
					capabilities: { tools: {} },
					serverInfo: { name: "hono-caldav", version: "1.0.0" },
				},
			};

		case "notifications/initialized":
			return { jsonrpc: "2.0", id, result: {} };

		case "tools/list":
			return {
				jsonrpc: "2.0",
				id,
				result: { tools: TOOLS },
			};

		case "tools/call": {
			const params = req.params as {
				name: string;
				arguments?: Record<string, unknown>;
			};
			if (!params?.name) {
				return {
					jsonrpc: "2.0",
					id,
					error: { code: -32602, message: "Missing tool name" },
				};
			}
			try {
				const result = await callTool(
					db,
					userId,
					params.name,
					params.arguments ?? {},
					env,
				);
				return { jsonrpc: "2.0", id, result };
			} catch (err) {
				return {
					jsonrpc: "2.0",
					id,
					error: {
						code: -32603,
						message: err instanceof Error ? err.message : "Internal error",
					},
				};
			}
		}

		case "ping":
			return { jsonrpc: "2.0", id, result: {} };

		default:
			return {
				jsonrpc: "2.0",
				id,
				error: { code: -32601, message: `Method not found: ${req.method}` },
			};
	}
}

async function callTool(
	db: D1Database,
	userId: string,
	name: string,
	args: Record<string, unknown>,
	env?: CloudflareBindings,
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
	switch (name) {
		case "list_calendars": {
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
							})),
							null,
							2,
						),
					},
				],
			};
		}

		case "list_tasks": {
			const calendarId = Number(args.calendarId);
			const cal = await getCalendarById(db, userId, calendarId);
			if (!cal) return errorResult("Calendar not found");
			const objects = await getObjectsForCalendar(db, calendarId);
			const tasks = objects.map((o) => parseTaskFromIcs(o.uid, o.icsData));
			return {
				content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }],
			};
		}

		case "get_task": {
			const calendarId = Number(args.calendarId);
			const cal = await getCalendarById(db, userId, calendarId);
			if (!cal) return errorResult("Calendar not found");
			const obj = await getObjectByUid(db, calendarId, String(args.uid));
			if (!obj) return errorResult("Task not found");
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(parseTaskFromIcs(obj.uid, obj.icsData), null, 2),
					},
				],
			};
		}

		case "create_task": {
			const calendarId = Number(args.calendarId);
			const cal = await getCalendarById(db, userId, calendarId);
			if (!cal || cal.componentType !== "VTODO")
				return errorResult("VTODO calendar not found");

			const uid = crypto.randomUUID();
			const now = formatTimestamp(new Date());
			const summary = String(args.summary);
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
			if (args.due) lines.push(`DUE:${args.due}`);
			if (args.priority !== undefined)
				lines.push(`PRIORITY:${args.priority}`);
			if (args.description) lines.push(`DESCRIPTION:${args.description}`);
			lines.push("END:VTODO", "END:VCALENDAR");

			await putObject(db, calendarId, uid, lines.join("\r\n") + "\r\n");
			return {
				content: [
					{ type: "text", text: `Created task "${summary}" (UID: ${uid})` },
				],
			};
		}

		case "update_task": {
			const calendarId = Number(args.calendarId);
			const cal = await getCalendarById(db, userId, calendarId);
			if (!cal) return errorResult("Calendar not found");
			const uid = String(args.uid);
			const obj = await getObjectByUid(db, calendarId, uid);
			if (!obj) return errorResult("Task not found");

			let ics = obj.icsData;
			const now = formatTimestamp(new Date());
			if (args.summary !== undefined)
				ics = replaceOrInsertProp(ics, "SUMMARY", String(args.summary));
			if (args.due !== undefined)
				ics = replaceOrInsertProp(ics, "DUE", String(args.due));
			if (args.priority !== undefined)
				ics = replaceOrInsertProp(ics, "PRIORITY", String(args.priority));
			if (args.description !== undefined)
				ics = replaceOrInsertProp(ics, "DESCRIPTION", String(args.description));
			if (args.status !== undefined) {
				ics = replaceOrInsertProp(ics, "STATUS", String(args.status));
				if (
					args.status === "COMPLETED" &&
					!ics.includes("COMPLETED:")
				) {
					ics = ics.replace("END:VTODO", `COMPLETED:${now}\r\nEND:VTODO`);
				}
			}
			ics = replaceOrInsertProp(ics, "LAST-MODIFIED", now);

			await putObject(db, calendarId, uid, ics);
			return { content: [{ type: "text", text: `Updated task ${uid}` }] };
		}

		case "complete_task": {
			const calendarId = Number(args.calendarId);
			const cal = await getCalendarById(db, userId, calendarId);
			if (!cal) return errorResult("Calendar not found");
			const uid = String(args.uid);
			const obj = await getObjectByUid(db, calendarId, uid);
			if (!obj) return errorResult("Task not found");

			const now = formatTimestamp(new Date());
			let ics = replaceOrInsertProp(obj.icsData, "STATUS", "COMPLETED");
			ics = replaceOrInsertProp(ics, "LAST-MODIFIED", now);
			if (!ics.includes("COMPLETED:")) {
				ics = ics.replace("END:VTODO", `COMPLETED:${now}\r\nEND:VTODO`);
			}

			await putObject(db, calendarId, uid, ics);
			return { content: [{ type: "text", text: `Completed task ${uid}` }] };
		}

		case "delete_task": {
			const calendarId = Number(args.calendarId);
			const cal = await getCalendarById(db, userId, calendarId);
			if (!cal) return errorResult("Calendar not found");
			const deleted = await deleteObject(db, calendarId, String(args.uid));
			return {
				content: [
					{
						type: "text",
						text: deleted ? `Deleted task ${args.uid}` : "Task not found",
					},
				],
				isError: !deleted,
			};
		}

		case "search_tasks": {
			const calendarId = Number(args.calendarId);
			const cal = await getCalendarById(db, userId, calendarId);
			if (!cal) return errorResult("Calendar not found");
			const query = String(args.query).toLowerCase();
			const status = args.status ? String(args.status) : undefined;
			const objects = await getObjectsForCalendar(db, calendarId);
			const tasks = objects
				.map((o) => parseTaskFromIcs(o.uid, o.icsData))
				.filter((t) => {
					const matchesQuery =
						t.summary.toLowerCase().includes(query) ||
						(t.description?.toLowerCase().includes(query) ?? false);
					const matchesStatus = status ? t.status === status : true;
					return matchesQuery && matchesStatus;
				});
			return {
				content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }],
			};
		}

		case "poll_gmail": {
			if (!env) return errorResult("Environment not available");
			const calendarId = Number(args.calendarId);
			const cal = await getCalendarById(db, userId, calendarId);
			if (!cal) return errorResult("Calendar not found");

			const accessToken = await getValidAccessToken(
				db,
				userId,
				env.GOOGLE_CLIENT_ID,
				env.GOOGLE_CLIENT_SECRET,
			);
			if (!accessToken) {
				return errorResult(
					"Could not obtain Google access token. Ensure Google OAuth is connected.",
				);
			}

			const result = await pollGmailForTasks(
				env.AI,
				db,
				accessToken,
				userId,
				calendarId,
			);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								created: result.created,
								errors: result.errors,
							},
							null,
							2,
						),
					},
				],
			};
		}

		case "check_calendar_availability": {
			if (!env) return errorResult("Environment not available");
			const gcalId = String(args.calendarId);
			const timeMin = String(args.timeMin);
			const timeMax = String(args.timeMax);

			const accessToken = await getValidAccessToken(
				db,
				userId,
				env.GOOGLE_CLIENT_ID,
				env.GOOGLE_CLIENT_SECRET,
			);
			if (!accessToken) {
				return errorResult(
					"Could not obtain Google access token. Ensure Google OAuth is connected.",
				);
			}

			const busySlots = await getFreeBusy(
				accessToken,
				gcalId,
				timeMin,
				timeMax,
			);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								calendarId: gcalId,
								timeMin,
								timeMax,
								busySlots,
								freeSlotCount:
									busySlots.length === 0
										? "Entire range is free"
										: `${busySlots.length} busy slot(s)`,
							},
							null,
							2,
						),
					},
				],
			};
		}

		default:
			return errorResult(`Unknown tool: ${name}`);
	}
}

// --- Helpers ---

function errorResult(message: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		isError: true,
	};
}

function jsonRpcError(
	id: string | number | null,
	code: number,
	message: string,
): Response {
	return new Response(
		JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }),
		{ headers: { "Content-Type": "application/json" } },
	);
}

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

function replaceOrInsertProp(
	ics: string,
	propName: string,
	value: string,
): string {
	const regex = new RegExp(`^${propName}[^:]*:.*$`, "im");
	if (regex.test(ics)) {
		return ics.replace(regex, `${propName}:${value}`);
	}
	return ics.replace("END:VTODO", `${propName}:${value}\r\nEND:VTODO`);
}
