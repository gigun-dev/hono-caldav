/**
 * Calendar sharing API.
 * Simple share model: owner shares a calendar with another user (by email/user_id).
 * Permissions: 'read' or 'read-write'.
 */

export type CalendarShare = {
	id: string;
	calendarId: number;
	ownerId: string;
	sharedWith: string;
	permission: string;
	createdAt: string;
};

/**
 * Share a calendar with another user.
 * Verifies the caller owns the calendar before creating the share.
 */
export async function shareCalendar(
	db: D1Database,
	ownerId: string,
	calendarId: number,
	sharedWith: string,
	permission: string = "read",
): Promise<CalendarShare | null> {
	// Prevent self-sharing
	if (ownerId === sharedWith) return null;

	// Verify calendar ownership
	const cal = await db
		.prepare("SELECT id FROM calendars WHERE id = ? AND user_id = ?")
		.bind(calendarId, ownerId)
		.first();
	if (!cal) return null;

	const result = await db
		.prepare(
			"INSERT INTO calendar_shares (calendar_id, owner_id, shared_with, permission) VALUES (?, ?, ?, ?) RETURNING id, calendar_id, owner_id, shared_with, permission, created_at",
		)
		.bind(calendarId, ownerId, sharedWith, permission)
		.first();
	return result ? rowToShare(result as Record<string, unknown>) : null;
}

/**
 * List all shares for a calendar. Only the owner can list shares.
 */
export async function listShares(
	db: D1Database,
	calendarId: number,
	ownerId: string,
): Promise<CalendarShare[]> {
	// Verify calendar ownership
	const cal = await db
		.prepare("SELECT id FROM calendars WHERE id = ? AND user_id = ?")
		.bind(calendarId, ownerId)
		.first();
	if (!cal) return [];

	const result = await db
		.prepare(
			"SELECT id, calendar_id, owner_id, shared_with, permission, created_at FROM calendar_shares WHERE calendar_id = ? AND owner_id = ? ORDER BY created_at DESC",
		)
		.bind(calendarId, ownerId)
		.all();
	return (result.results ?? []).map(rowToShare);
}

/**
 * Revoke a share. Only the owner can revoke.
 */
export async function revokeShare(
	db: D1Database,
	shareId: string,
	ownerId: string,
): Promise<boolean> {
	const existing = await db
		.prepare(
			"SELECT id FROM calendar_shares WHERE id = ? AND owner_id = ?",
		)
		.bind(shareId, ownerId)
		.first();
	if (!existing) return false;

	await db
		.prepare(
			"DELETE FROM calendar_shares WHERE id = ? AND owner_id = ?",
		)
		.bind(shareId, ownerId)
		.run();
	return true;
}

/**
 * Get calendars shared with a user (by email or user_id).
 * Returns calendar info along with the share permission.
 */
export async function getSharedCalendars(
	db: D1Database,
	userId: string,
): Promise<
	Array<{
		shareId: string;
		calendarId: number;
		calendarName: string;
		componentType: string;
		ownerEmail: string;
		permission: string;
	}>
> {
	// Single query with JOIN to avoid N+1
	const result = await db
		.prepare(
			`SELECT cs.id AS share_id, cs.calendar_id, cs.owner_id, cs.shared_with, cs.permission, cs.created_at,
				c.name AS calendar_name, c.component_type,
				u.email AS owner_email, u.name AS owner_name
			FROM calendar_shares cs
			JOIN calendars c ON cs.calendar_id = c.id
			LEFT JOIN "user" u ON cs.owner_id = u.id
			WHERE cs.shared_with = ?
			ORDER BY cs.created_at DESC`,
		)
		.bind(userId)
		.all();

	return (result.results ?? []).map((row) => ({
		shareId: row.share_id as string,
		calendarId: row.calendar_id as number,
		calendarName: row.calendar_name as string,
		componentType: row.component_type as string,
		ownerEmail: (row.owner_email as string) ?? (row.owner_id as string),
		permission: row.permission as string,
	}));
}

function rowToShare(row: Record<string, unknown>): CalendarShare {
	return {
		id: row.id as string,
		calendarId: row.calendar_id as number,
		ownerId: row.owner_id as string,
		sharedWith: row.shared_with as string,
		permission: row.permission as string,
		createdAt: row.created_at as string,
	};
}
