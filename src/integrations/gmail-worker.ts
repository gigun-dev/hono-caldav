/**
 * Gmail polling logic: fetch emails, extract tasks via Workers AI, store as VTODO.
 */

import { fetchRecentEmails } from "./gmail.js";
import type { GmailMessage } from "./gmail.js";
import { putObject } from "../caldav/storage.js";

export type PollResult = {
	created: number;
	errors: string[];
};

type ExtractedTask = {
	summary: string;
	due?: string;
	priority?: number;
	description?: string;
};

/**
 * Poll Gmail for new emails and extract tasks using Workers AI.
 * @param ai - Cloudflare Workers AI binding
 * @param db - D1 database binding
 * @param accessToken - Google OAuth access token with gmail.readonly scope
 * @param userId - User ID for tracking sync state
 * @param calendarId - Target calendar ID for created VTODOs
 */
export async function pollGmailForTasks(
	ai: Ai,
	db: D1Database,
	accessToken: string,
	userId: string,
	calendarId: number,
): Promise<PollResult> {
	const result: PollResult = { created: 0, errors: [] };

	// Get last poll timestamp
	const lastPoll = await getLastPollTime(db, userId);
	const after = lastPoll ?? undefined;

	// Fetch recent emails
	let emails: GmailMessage[];
	try {
		emails = await fetchRecentEmails(accessToken, 10, after);
	} catch (err) {
		result.errors.push(
			`Failed to fetch emails: ${err instanceof Error ? err.message : String(err)}`,
		);
		return result;
	}

	if (emails.length === 0) {
		await updateLastPollTime(db, userId);
		return result;
	}

	// Process each email through AI
	for (const email of emails) {
		try {
			const tasks = await extractTasksFromEmail(ai, email);
			for (const task of tasks) {
				await createVtodoFromTask(db, calendarId, task);
				result.created++;
			}
		} catch (err) {
			result.errors.push(
				`Error processing email "${email.subject}": ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	await updateLastPollTime(db, userId);
	return result;
}

/**
 * Use Workers AI to extract tasks from an email.
 * Exported for testing.
 */
export async function extractTasksFromEmail(
	ai: Ai,
	email: GmailMessage,
): Promise<ExtractedTask[]> {
	const bodyPreview = email.bodyText.slice(0, 2000);

	const response = await ai.run(
		"@cf/meta/llama-3.1-8b-instruct" as BaseAiTextGenerationModels,
		{
			messages: [
				{
					role: "system",
					content: `You analyze emails to extract actionable tasks. If the email contains tasks or action items, output a JSON array of task objects. Each task object has: "summary" (string, required), "due" (string in YYYYMMDD format, optional), "priority" (number 1-9 where 1=highest, optional), "description" (string, optional).

If the email does NOT contain any actionable tasks, output an empty array: []

Output ONLY valid JSON, no explanation.`,
				},
				{
					role: "user",
					content: `Subject: ${email.subject}\nFrom: ${email.from}\nDate: ${email.date}\n\n${bodyPreview}`,
				},
			],
			max_tokens: 500,
		},
	);

	const aiText = (response as { response?: string }).response ?? "";
	return parseExtractedTasks(aiText);
}

/**
 * Parse AI response into extracted tasks.
 * Exported for testing.
 */
export function parseExtractedTasks(aiText: string): ExtractedTask[] {
	// Try to find JSON array in the response
	const arrayMatch = aiText.match(/\[[\s\S]*\]/);
	if (!arrayMatch) {
		return [];
	}

	try {
		const parsed = JSON.parse(arrayMatch[0]) as unknown;
		if (!Array.isArray(parsed)) return [];

		return parsed
			.filter(
				(item): item is Record<string, unknown> =>
					typeof item === "object" && item !== null && "summary" in item,
			)
			.map((item) => ({
				summary: String(item.summary),
				due: item.due ? String(item.due) : undefined,
				priority:
					typeof item.priority === "number" ? item.priority : undefined,
				description: item.description
					? String(item.description)
					: undefined,
			}));
	} catch {
		return [];
	}
}

async function createVtodoFromTask(
	db: D1Database,
	calendarId: number,
	task: ExtractedTask,
): Promise<void> {
	const uid = crypto.randomUUID();
	const now = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";

	const lines = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//hono-caldav//Gmail//EN",
		"BEGIN:VTODO",
		`UID:${uid}`,
		`DTSTAMP:${now}`,
		`CREATED:${now}`,
		`SUMMARY:${task.summary}`,
		"STATUS:NEEDS-ACTION",
	];

	if (task.due) lines.push(`DUE:${task.due}`);
	if (task.priority !== undefined) lines.push(`PRIORITY:${task.priority}`);
	if (task.description) lines.push(`DESCRIPTION:${task.description}`);
	lines.push("END:VTODO", "END:VCALENDAR");

	await putObject(db, calendarId, uid, lines.join("\r\n") + "\r\n");
}

async function getLastPollTime(
	db: D1Database,
	userId: string,
): Promise<string | null> {
	const row = await db
		.prepare(
			"SELECT last_poll_at FROM gmail_sync_state WHERE user_id = ?",
		)
		.bind(userId)
		.first<{ last_poll_at: string | null }>();
	return row?.last_poll_at ?? null;
}

async function updateLastPollTime(
	db: D1Database,
	userId: string,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO gmail_sync_state (user_id, last_poll_at)
			 VALUES (?, datetime('now'))
			 ON CONFLICT(user_id) DO UPDATE SET last_poll_at = datetime('now')`,
		)
		.bind(userId)
		.run();
}
