/**
 * D1-based CalDAV storage.
 * ICS data is stored as-is. Metadata is minimal (uid, etag, timestamps).
 * calendarchanges tracks add/update/delete for sync-collection.
 */

export type Calendar = {
	id: number;
	userId: string;
	name: string;
	componentType: string;
	ctag: string;
	synctoken: number;
	color: string | null;
	calendarOrder: number | null;
	createdAt: string;
	updatedAt: string;
};

export type CalendarObject = {
	id: number;
	calendarId: number;
	uid: string;
	etag: string;
	icsData: string;
	createdAt: string;
	updatedAt: string;
};

export type CalendarChange = {
	id: number;
	calendarId: number;
	uri: string;
	synctoken: number;
	operation: 1 | 2 | 3; // 1=add, 2=update, 3=delete
};

export type UserDefaultCalendars = {
	userId: string;
	taskListCalendarId: number;
	eventCalendarId: number;
	createdAt: string;
	updatedAt: string;
};

// --- Calendar CRUD ---

export async function getCalendarsForUser(
	db: D1Database,
	userId: string,
): Promise<Calendar[]> {
	const result = await db
		.prepare(
			"SELECT id, user_id, name, component_type, ctag, synctoken, color, calendar_order, created_at, updated_at FROM calendars WHERE user_id = ? ORDER BY id ASC",
		)
		.bind(userId)
		.all();
	return (result.results ?? []).map(rowToCalendar);
}

export async function getCalendarById(
	db: D1Database,
	userId: string,
	calendarId: number,
): Promise<Calendar | null> {
	const row = await db
		.prepare(
			"SELECT id, user_id, name, component_type, ctag, synctoken, color, calendar_order, created_at, updated_at FROM calendars WHERE id = ? AND user_id = ?",
		)
		.bind(calendarId, userId)
		.first();
	return row ? rowToCalendar(row) : null;
}

export async function createCalendar(
	db: D1Database,
	userId: string,
	name: string,
	componentType: string,
	color?: string | null,
	calendarOrder?: number | null,
): Promise<Calendar> {
	const result = await db
		.prepare(
			"INSERT INTO calendars (user_id, name, component_type, color, calendar_order) VALUES (?, ?, ?, ?, ?) RETURNING id, user_id, name, component_type, ctag, synctoken, color, calendar_order, created_at, updated_at",
		)
		.bind(userId, name, componentType, color ?? null, calendarOrder ?? null)
		.first();
	return rowToCalendar(result as Record<string, unknown>);
}

/**
 * 初回 cron 用: ユーザーにサーバー専用のカレンダー・リストがなければ作成し、ID を user_default_calendars に保存する。
 * - VTODO「メールから」: Gmail 抽出タスク用リスト
 * - VEVENT「予定」: イベント用カレンダー
 */
export async function ensureDefaultCalendarsForUser(
	db: D1Database,
	userId: string,
): Promise<UserDefaultCalendars> {
	const existing = await getDefaultCalendarsForUser(db, userId);
	if (existing) return existing;

	const taskList = await createCalendar(
		db,
		userId,
		"メールから",
		"VTODO",
		"#4ECDC4",
		0,
	);
	const eventCal = await createCalendar(
		db,
		userId,
		"予定",
		"VEVENT",
		"#45B7D1",
		1,
	);
	await db
		.prepare(
			"INSERT INTO user_default_calendars (user_id, task_list_calendar_id, event_calendar_id) VALUES (?, ?, ?)",
		)
		.bind(userId, taskList.id, eventCal.id)
		.run();
	const created = await getDefaultCalendarsForUser(db, userId);
	if (!created) throw new Error("user_default_calendars: row not found after insert");
	return created;
}

/**
 * user_default_calendars からユーザーのサーバー専用カレンダー・リスト ID を取得する。
 */
export async function getDefaultCalendarsForUser(
	db: D1Database,
	userId: string,
): Promise<UserDefaultCalendars | null> {
	const row = await db
		.prepare(
			"SELECT user_id, task_list_calendar_id, event_calendar_id, created_at, updated_at FROM user_default_calendars WHERE user_id = ?",
		)
		.bind(userId)
		.first();
	return row ? rowToUserDefaultCalendars(row as Record<string, unknown>) : null;
}

export async function updateCalendarDisplayName(
	db: D1Database,
	userId: string,
	calendarId: number,
	displayName: string,
): Promise<Calendar | null> {
	await db
		.prepare(
			"UPDATE calendars SET name = ?, ctag = CAST(strftime('%s','now') AS TEXT), updated_at = datetime('now') WHERE id = ? AND user_id = ?",
		)
		.bind(displayName, calendarId, userId)
		.run();
	return getCalendarById(db, userId, calendarId);
}

export async function updateCalendarColor(
	db: D1Database,
	userId: string,
	calendarId: number,
	color: string,
): Promise<Calendar | null> {
	await db
		.prepare(
			"UPDATE calendars SET color = ?, ctag = CAST(strftime('%s','now') AS TEXT), updated_at = datetime('now') WHERE id = ? AND user_id = ?",
		)
		.bind(color, calendarId, userId)
		.run();
	return getCalendarById(db, userId, calendarId);
}

export async function updateCalendarOrder(
	db: D1Database,
	userId: string,
	calendarId: number,
	order: number,
): Promise<Calendar | null> {
	await db
		.prepare(
			"UPDATE calendars SET calendar_order = ?, ctag = CAST(strftime('%s','now') AS TEXT), updated_at = datetime('now') WHERE id = ? AND user_id = ?",
		)
		.bind(order, calendarId, userId)
		.run();
	return getCalendarById(db, userId, calendarId);
}

export async function deleteCalendar(
	db: D1Database,
	userId: string,
	calendarId: number,
): Promise<boolean> {
	const cal = await getCalendarById(db, userId, calendarId);
	if (!cal) return false;
	await db
		.prepare("DELETE FROM calendarchanges WHERE calendar_id = ?")
		.bind(calendarId)
		.run();
	await db
		.prepare("DELETE FROM calendar_objects WHERE calendar_id = ?")
		.bind(calendarId)
		.run();
	await db
		.prepare("DELETE FROM calendars WHERE id = ? AND user_id = ?")
		.bind(calendarId, userId)
		.run();
	return true;
}

// --- CalendarObject CRUD ---

export async function getObjectsForCalendar(
	db: D1Database,
	calendarId: number,
): Promise<CalendarObject[]> {
	const result = await db
		.prepare(
			"SELECT id, calendar_id, uid, etag, ics_data, created_at, updated_at FROM calendar_objects WHERE calendar_id = ? ORDER BY updated_at DESC",
		)
		.bind(calendarId)
		.all();
	return (result.results ?? []).map(rowToCalendarObject);
}

export async function getObjectByUid(
	db: D1Database,
	calendarId: number,
	uid: string,
): Promise<CalendarObject | null> {
	const row = await db
		.prepare(
			"SELECT id, calendar_id, uid, etag, ics_data, created_at, updated_at FROM calendar_objects WHERE calendar_id = ? AND uid COLLATE NOCASE = ?",
		)
		.bind(calendarId, uid)
		.first();
	return row ? rowToCalendarObject(row) : null;
}

export async function putObject(
	db: D1Database,
	calendarId: number,
	uid: string,
	icsData: string,
): Promise<{ object: CalendarObject; created: boolean }> {
	const etag = await generateEtag(icsData);
	const existing = await getObjectByUid(db, calendarId, uid);

	if (existing) {
		// Update
		await db
			.prepare(
				"UPDATE calendar_objects SET etag = ?, ics_data = ?, updated_at = datetime('now') WHERE id = ?",
			)
			.bind(etag, icsData, existing.id)
			.run();
		await recordChange(db, calendarId, `${uid}.ics`, 2);
		const updated = await getObjectByUid(db, calendarId, uid);
		return { object: updated!, created: false };
	}

	// Insert
	await db
		.prepare(
			"INSERT INTO calendar_objects (calendar_id, uid, etag, ics_data) VALUES (?, ?, ?, ?)",
		)
		.bind(calendarId, uid, etag, icsData)
		.run();
	await recordChange(db, calendarId, `${uid}.ics`, 1);
	const inserted = await getObjectByUid(db, calendarId, uid);
	return { object: inserted!, created: true };
}

export async function deleteObject(
	db: D1Database,
	calendarId: number,
	uid: string,
): Promise<boolean> {
	const existing = await getObjectByUid(db, calendarId, uid);
	if (!existing) {
		return false;
	}
	await db
		.prepare(
			"DELETE FROM calendar_objects WHERE calendar_id = ? AND uid COLLATE NOCASE = ?",
		)
		.bind(calendarId, uid)
		.run();
	await recordChange(db, calendarId, `${uid}.ics`, 3);
	return true;
}

// --- Sync support ---

export async function getChangesSince(
	db: D1Database,
	calendarId: number,
	sinceSynctoken: number,
): Promise<CalendarChange[]> {
	const result = await db
		.prepare(
			"SELECT id, calendar_id, uri, synctoken, operation FROM calendarchanges WHERE calendar_id = ? AND synctoken > ? ORDER BY id ASC",
		)
		.bind(calendarId, sinceSynctoken)
		.all();
	return (result.results ?? []).map(rowToChange);
}

// --- Internal helpers ---

async function recordChange(
	db: D1Database,
	calendarId: number,
	uri: string,
	operation: 1 | 2 | 3,
): Promise<void> {
	// Bump synctoken atomically and get the new value
	const next = await db
		.prepare(
			"UPDATE calendars SET synctoken = synctoken + 1, ctag = CAST(strftime('%s','now') AS TEXT), updated_at = datetime('now') WHERE id = ? RETURNING synctoken",
		)
		.bind(calendarId)
		.first<{ synctoken: number }>();

	if (!next) return;

	await db
		.prepare(
			"INSERT INTO calendarchanges (calendar_id, uri, synctoken, operation) VALUES (?, ?, ?, ?)",
		)
		.bind(calendarId, uri, next.synctoken, operation)
		.run();
}

async function generateEtag(data: string): Promise<string> {
	const encoded = new TextEncoder().encode(data);
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
	const hashArray = new Uint8Array(hashBuffer);
	const hex = Array.from(hashArray, (b) => b.toString(16).padStart(2, "0")).join(
		"",
	);
	return `"${hex}"`;
}

function rowToCalendar(row: Record<string, unknown>): Calendar {
	return {
		id: row.id as number,
		userId: row.user_id as string,
		name: row.name as string,
		componentType: row.component_type as string,
		ctag: String(row.ctag),
		synctoken: row.synctoken as number,
		color: (row.color as string) ?? null,
		calendarOrder:
			row.calendar_order != null ? (row.calendar_order as number) : null,
		createdAt: row.created_at as string,
		updatedAt: row.updated_at as string,
	};
}

function rowToCalendarObject(row: Record<string, unknown>): CalendarObject {
	return {
		id: row.id as number,
		calendarId: row.calendar_id as number,
		uid: row.uid as string,
		etag: row.etag as string,
		icsData: row.ics_data as string,
		createdAt: row.created_at as string,
		updatedAt: row.updated_at as string,
	};
}

function rowToChange(row: Record<string, unknown>): CalendarChange {
	return {
		id: row.id as number,
		calendarId: row.calendar_id as number,
		uri: row.uri as string,
		synctoken: row.synctoken as number,
		operation: row.operation as 1 | 2 | 3,
	};
}

function rowToUserDefaultCalendars(
	row: Record<string, unknown>,
): UserDefaultCalendars {
	return {
		userId: row.user_id as string,
		taskListCalendarId: row.task_list_calendar_id as number,
		eventCalendarId: row.event_calendar_id as number,
		createdAt: row.created_at as string,
		updatedAt: row.updated_at as string,
	};
}
