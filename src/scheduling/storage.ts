/**
 * Attendee storage operations for iTIP scheduling.
 */

export type Attendee = {
	id: number;
	calendarObjectId: number;
	email: string;
	partstat: string;
	rsvp: boolean;
	sentAt: string | null;
	repliedAt: string | null;
	createdAt: string;
};

export async function addAttendees(
	db: D1Database,
	calendarObjectId: number,
	attendees: { email: string; partstat?: string; rsvp?: boolean }[],
): Promise<void> {
	for (const att of attendees) {
		await db
			.prepare(
				"INSERT OR IGNORE INTO attendees (calendar_object_id, email, partstat, rsvp) VALUES (?, ?, ?, ?)",
			)
			.bind(
				calendarObjectId,
				att.email.toLowerCase(),
				att.partstat ?? "NEEDS-ACTION",
				att.rsvp !== false ? 1 : 0,
			)
			.run();
	}
}

export async function getAttendees(
	db: D1Database,
	calendarObjectId: number,
): Promise<Attendee[]> {
	const result = await db
		.prepare(
			"SELECT id, calendar_object_id, email, partstat, rsvp, sent_at, replied_at, created_at FROM attendees WHERE calendar_object_id = ?",
		)
		.bind(calendarObjectId)
		.all();
	return (result.results ?? []).map(rowToAttendee);
}

export async function updatePartstat(
	db: D1Database,
	calendarObjectId: number,
	email: string,
	partstat: string,
): Promise<boolean> {
	// Check if the attendee exists first
	const existing = await db
		.prepare(
			"SELECT id FROM attendees WHERE calendar_object_id = ? AND email = ?",
		)
		.bind(calendarObjectId, email.toLowerCase())
		.first();
	if (!existing) return false;

	await db
		.prepare(
			"UPDATE attendees SET partstat = ?, replied_at = datetime('now') WHERE calendar_object_id = ? AND email = ?",
		)
		.bind(partstat, calendarObjectId, email.toLowerCase())
		.run();
	return true;
}

export async function markSent(
	db: D1Database,
	calendarObjectId: number,
	email: string,
): Promise<void> {
	await db
		.prepare(
			"UPDATE attendees SET sent_at = datetime('now') WHERE calendar_object_id = ? AND email = ?",
		)
		.bind(calendarObjectId, email.toLowerCase())
		.run();
}

export async function findObjectByUidGlobal(
	db: D1Database,
	uid: string,
): Promise<{ id: number; calendarId: number; icsData: string } | null> {
	const row = await db
		.prepare(
			"SELECT id, calendar_id, ics_data FROM calendar_objects WHERE uid COLLATE NOCASE = ?",
		)
		.bind(uid)
		.first<{ id: number; calendar_id: number; ics_data: string }>();
	if (!row) return null;
	return { id: row.id, calendarId: row.calendar_id, icsData: row.ics_data };
}

export type FeedbackInput = {
	calendarObjectId: number;
	attendeeEmail: string;
	feedbackType: string;
	originalDtstart: string | null;
	originalDtend: string | null;
	proposedDtstart: string | null;
	proposedDtend: string | null;
};

export async function addFeedback(
	db: D1Database,
	feedback: FeedbackInput,
): Promise<void> {
	await db
		.prepare(
			"INSERT INTO scheduling_feedback (calendar_object_id, attendee_email, feedback_type, original_dtstart, original_dtend, proposed_dtstart, proposed_dtend) VALUES (?, ?, ?, ?, ?, ?, ?)",
		)
		.bind(
			feedback.calendarObjectId,
			feedback.attendeeEmail.toLowerCase(),
			feedback.feedbackType,
			feedback.originalDtstart,
			feedback.originalDtend,
			feedback.proposedDtstart,
			feedback.proposedDtend,
		)
		.run();
}

function rowToAttendee(row: Record<string, unknown>): Attendee {
	return {
		id: row.id as number,
		calendarObjectId: row.calendar_object_id as number,
		email: row.email as string,
		partstat: row.partstat as string,
		rsvp: (row.rsvp as number) === 1,
		sentAt: (row.sent_at as string) ?? null,
		repliedAt: (row.replied_at as string) ?? null,
		createdAt: row.created_at as string,
	};
}
