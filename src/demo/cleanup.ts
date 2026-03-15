/**
 * Cleanup expired demo users (24h+).
 * Deletes calendars/objects/changes, then the user row (cascades session/account).
 */

export async function cleanupDemoUsers(
	db: D1Database,
): Promise<{ deleted: number }> {
	// Find demo users older than 24 hours
	const users = await db
		.prepare(
			`SELECT id FROM "user" WHERE email LIKE '%@demo.caldav.local' AND "createdAt" < datetime('now', '-24 hours')`,
		)
		.all<{ id: string }>();

	const rows = users.results ?? [];
	if (rows.length === 0) return { deleted: 0 };

	const userIds = rows.map((r) => r.id);

	// Delete in dependency order using batch
	const stmts: D1PreparedStatement[] = [];
	for (const userId of userIds) {
		// calendarchanges → calendar_objects depend on calendars
		stmts.push(
			db.prepare(
				"DELETE FROM calendarchanges WHERE calendar_id IN (SELECT id FROM calendars WHERE user_id = ?)",
			).bind(userId),
		);
		stmts.push(
			db.prepare(
				"DELETE FROM calendar_objects WHERE calendar_id IN (SELECT id FROM calendars WHERE user_id = ?)",
			).bind(userId),
		);
		stmts.push(
			db.prepare("DELETE FROM calendars WHERE user_id = ?").bind(userId),
		);
		stmts.push(
			db.prepare(
				"DELETE FROM app_passwords WHERE user_id = ?",
			).bind(userId),
		);
		// user deletion cascades session/account via better-auth schema
		stmts.push(
			db.prepare('DELETE FROM "user" WHERE id = ?').bind(userId),
		);
	}

	await db.batch(stmts);

	return { deleted: userIds.length };
}
