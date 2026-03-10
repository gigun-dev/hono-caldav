/**
 * Natural language CRUD handler using Workers AI.
 * Converts free-text input into structured task operations via LLM.
 */

import {
	getObjectsForCalendar,
	getObjectByUid,
	putObject,
	deleteObject,
} from "../caldav/storage.js";

export type NlResult = {
	action: string;
	message: string;
	data?: unknown;
};

type AiParsed = Record<string, unknown>;

/**
 * Process a natural language input and execute the corresponding task operation.
 */
export async function processNaturalLanguage(
	ai: Ai,
	db: D1Database,
	userId: string,
	calendarId: number,
	input: string,
): Promise<NlResult> {
	// Get existing tasks for context
	const objects = await getObjectsForCalendar(db, calendarId);
	const existingTasks = objects.map((o) => ({
		uid: o.uid,
		summary: extractProp(o.icsData, "SUMMARY") ?? "Untitled",
		status: extractProp(o.icsData, "STATUS") ?? "NEEDS-ACTION",
		due: extractProp(o.icsData, "DUE") ?? null,
	}));

	const systemPrompt = buildSystemPrompt(existingTasks);

	const response = await ai.run("@cf/meta/llama-3.1-8b-instruct" as BaseAiTextGenerationModels, {
		messages: [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: input },
		],
		max_tokens: 500,
	});

	const aiText = (response as { response?: string }).response ?? "";

	const parsed = parseAiResponse(aiText);
	if (!parsed) {
		return {
			action: "error",
			message: "Could not parse AI response",
			data: { raw: aiText },
		};
	}

	return executeAction(db, calendarId, parsed);
}

/**
 * Build the system prompt with current task context.
 * Exported for testing.
 */
export function buildSystemPrompt(
	existingTasks: { uid: string; summary: string; status: string; due: string | null }[],
): string {
	return `You are a task management assistant. Based on the user's request, output a JSON action.

Current tasks:
${JSON.stringify(existingTasks, null, 2)}

Output EXACTLY one JSON object (no markdown, no explanation) with one of these formats:

Create: {"action":"create","summary":"task title","due":"YYYYMMDD" or "YYYYMMDDTHHmmssZ" or null,"priority":1-9 or null,"description":"text or null"}
Complete: {"action":"complete","uid":"matching-task-uid"}
Delete: {"action":"delete","uid":"matching-task-uid"}
Update: {"action":"update","uid":"matching-task-uid","summary":"new title or null","due":"new date or null","status":"NEEDS-ACTION|IN-PROCESS|COMPLETED|CANCELLED or null"}
List: {"action":"list"}
Search: {"action":"search","query":"search term"}`;
}

/**
 * Parse the AI response text into a structured object.
 * Handles markdown code blocks and raw JSON.
 * Exported for testing.
 */
export function parseAiResponse(aiText: string): AiParsed | null {
	const jsonMatch = aiText.match(/\{[\s\S]*\}/);
	if (!jsonMatch) {
		return null;
	}

	try {
		return JSON.parse(jsonMatch[0]) as AiParsed;
	} catch {
		return null;
	}
}

/**
 * Execute a parsed AI action against the storage layer.
 * Exported for testing.
 */
export async function executeAction(
	db: D1Database,
	calendarId: number,
	parsed: AiParsed,
): Promise<NlResult> {
	const action = String(parsed.action ?? "");

	switch (action) {
		case "create": {
			const summary = String(parsed.summary ?? "Untitled");
			const uid = crypto.randomUUID();
			const now = formatTimestamp(new Date());
			const lines = [
				"BEGIN:VCALENDAR",
				"VERSION:2.0",
				"PRODID:-//hono-caldav//AI//EN",
				"BEGIN:VTODO",
				`UID:${uid}`,
				`DTSTAMP:${now}`,
				`CREATED:${now}`,
				`SUMMARY:${summary}`,
				"STATUS:NEEDS-ACTION",
			];
			if (parsed.due) lines.push(`DUE:${parsed.due}`);
			if (parsed.priority !== undefined && parsed.priority !== null) {
				lines.push(`PRIORITY:${parsed.priority}`);
			}
			if (parsed.description) lines.push(`DESCRIPTION:${parsed.description}`);
			lines.push("END:VTODO", "END:VCALENDAR");

			await putObject(db, calendarId, uid, lines.join("\r\n") + "\r\n");
			return {
				action: "create",
				message: `Created task "${summary}" (UID: ${uid})`,
				data: { uid, summary },
			};
		}

		case "complete": {
			const uid = String(parsed.uid ?? "");
			const obj = await getObjectByUid(db, calendarId, uid);
			if (!obj) {
				return { action: "error", message: `Task not found: ${uid}` };
			}

			const now = formatTimestamp(new Date());
			let ics = replaceOrInsertProp(obj.icsData, "STATUS", "COMPLETED");
			ics = replaceOrInsertProp(ics, "LAST-MODIFIED", now);
			if (!ics.includes("COMPLETED:")) {
				ics = ics.replace("END:VTODO", `COMPLETED:${now}\r\nEND:VTODO`);
			}

			await putObject(db, calendarId, uid, ics);
			return {
				action: "complete",
				message: `Completed task ${uid}`,
				data: { uid },
			};
		}

		case "delete": {
			const uid = String(parsed.uid ?? "");
			const deleted = await deleteObject(db, calendarId, uid);
			if (!deleted) {
				return { action: "error", message: `Task not found: ${uid}` };
			}
			return {
				action: "delete",
				message: `Deleted task ${uid}`,
				data: { uid },
			};
		}

		case "update": {
			const uid = String(parsed.uid ?? "");
			const obj = await getObjectByUid(db, calendarId, uid);
			if (!obj) {
				return { action: "error", message: `Task not found: ${uid}` };
			}

			let ics = obj.icsData;
			const now = formatTimestamp(new Date());
			if (parsed.summary !== undefined && parsed.summary !== null) {
				ics = replaceOrInsertProp(ics, "SUMMARY", String(parsed.summary));
			}
			if (parsed.due !== undefined && parsed.due !== null) {
				ics = replaceOrInsertProp(ics, "DUE", String(parsed.due));
			}
			if (parsed.status !== undefined && parsed.status !== null) {
				ics = replaceOrInsertProp(ics, "STATUS", String(parsed.status));
				if (
					parsed.status === "COMPLETED" &&
					!ics.includes("COMPLETED:")
				) {
					ics = ics.replace("END:VTODO", `COMPLETED:${now}\r\nEND:VTODO`);
				}
			}
			ics = replaceOrInsertProp(ics, "LAST-MODIFIED", now);

			await putObject(db, calendarId, uid, ics);
			return {
				action: "update",
				message: `Updated task ${uid}`,
				data: { uid },
			};
		}

		case "list": {
			const objects = await getObjectsForCalendar(db, calendarId);
			const tasks = objects.map((o) => ({
				uid: o.uid,
				summary: extractProp(o.icsData, "SUMMARY") ?? "Untitled",
				status: extractProp(o.icsData, "STATUS") ?? "NEEDS-ACTION",
				due: extractProp(o.icsData, "DUE") ?? null,
			}));
			return {
				action: "list",
				message: `Found ${tasks.length} task(s)`,
				data: { tasks },
			};
		}

		case "search": {
			const query = String(parsed.query ?? "").toLowerCase();
			const objects = await getObjectsForCalendar(db, calendarId);
			const tasks = objects
				.map((o) => ({
					uid: o.uid,
					summary: extractProp(o.icsData, "SUMMARY") ?? "Untitled",
					status: extractProp(o.icsData, "STATUS") ?? "NEEDS-ACTION",
					due: extractProp(o.icsData, "DUE") ?? null,
					description: extractProp(o.icsData, "DESCRIPTION") ?? null,
				}))
				.filter(
					(t) =>
						t.summary.toLowerCase().includes(query) ||
						(t.description?.toLowerCase().includes(query) ?? false),
				);
			return {
				action: "search",
				message: `Found ${tasks.length} matching task(s)`,
				data: { tasks },
			};
		}

		default:
			return {
				action: "error",
				message: `Unknown action: ${action}`,
				data: { parsed },
			};
	}
}

// --- Helpers ---

function formatTimestamp(date: Date): string {
	return date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
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
