/**
 * Demo data seeder.
 * Creates sample calendars with VTODO and VEVENT items for demo users.
 */

import {
	createCalendar,
	getCalendarsForUser,
	putObject,
} from "../caldav/storage.js";

function formatDate(d: Date): string {
	return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function addDays(base: Date, days: number): Date {
	const d = new Date(base);
	d.setDate(d.getDate() + days);
	return d;
}

function makeVtodo(
	uid: string,
	summary: string,
	opts: {
		due?: Date;
		priority?: number;
		status?: string;
	} = {},
): string {
	const now = formatDate(new Date());
	const lines = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//CalDAV Demo//EN",
		"BEGIN:VTODO",
		`UID:${uid}`,
		`DTSTAMP:${now}`,
		`SUMMARY:${summary}`,
	];
	if (opts.due) lines.push(`DUE:${formatDate(opts.due)}`);
	if (opts.priority != null) lines.push(`PRIORITY:${opts.priority}`);
	lines.push(`STATUS:${opts.status ?? "NEEDS-ACTION"}`);
	lines.push("END:VTODO", "END:VCALENDAR");
	return lines.join("\r\n");
}

function makeVevent(
	uid: string,
	summary: string,
	opts: {
		dtstart: string;
		dtend: string;
		rrule?: string;
	},
): string {
	const now = formatDate(new Date());
	const lines = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//CalDAV Demo//EN",
		"BEGIN:VEVENT",
		`UID:${uid}`,
		`DTSTAMP:${now}`,
		`SUMMARY:${summary}`,
		`DTSTART:${opts.dtstart}`,
		`DTEND:${opts.dtend}`,
	];
	if (opts.rrule) lines.push(`RRULE:${opts.rrule}`);
	lines.push("END:VEVENT", "END:VCALENDAR");
	return lines.join("\r\n");
}

export async function seedDemoData(
	db: D1Database,
	userId: string,
): Promise<void> {
	// Skip if user already has calendars (fixed mode re-visit)
	const existing = await getCalendarsForUser(db, userId);
	if (existing.length > 0) return;

	const now = new Date();

	// 1. 仕事 (VTODO)
	const work = await createCalendar(
		db,
		userId,
		"仕事",
		"VTODO",
		"#FF6B6B",
	);
	await putObject(
		db,
		work.id,
		"demo-work-1",
		makeVtodo("demo-work-1", "週次レポート作成", {
			due: addDays(now, 1),
			priority: 1,
		}),
	);
	await putObject(
		db,
		work.id,
		"demo-work-2",
		makeVtodo("demo-work-2", "クライアントMTG準備", {
			due: addDays(now, 3),
			priority: 5,
		}),
	);
	await putObject(
		db,
		work.id,
		"demo-work-3",
		makeVtodo("demo-work-3", "コードレビュー", {
			priority: 9,
			status: "COMPLETED",
		}),
	);

	// 2. プライベート (VTODO)
	const priv = await createCalendar(
		db,
		userId,
		"プライベート",
		"VTODO",
		"#4ECDC4",
	);
	await putObject(
		db,
		priv.id,
		"demo-private-1",
		makeVtodo("demo-private-1", "スーパーで買い物", {
			due: now,
		}),
	);
	await putObject(
		db,
		priv.id,
		"demo-private-2",
		makeVtodo("demo-private-2", "ジムに行く", {
			due: addDays(now, 1),
		}),
	);
	await putObject(
		db,
		priv.id,
		"demo-private-3",
		makeVtodo("demo-private-3", "本を読む", {
			status: "IN-PROCESS",
		}),
	);

	// 3. スケジュール (VEVENT)
	const schedule = await createCalendar(
		db,
		userId,
		"スケジュール",
		"VEVENT",
		"#45B7D1",
	);
	const standup = new Date(now);
	standup.setUTCHours(10, 0, 0, 0);
	const standupEnd = new Date(standup);
	standupEnd.setUTCMinutes(30);

	await putObject(
		db,
		schedule.id,
		"demo-event-1",
		makeVevent("demo-event-1", "チームスタンドアップ", {
			dtstart: formatDate(standup),
			dtend: formatDate(standupEnd),
			rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR",
		}),
	);

	const oneOnOne = new Date(now);
	oneOnOne.setUTCHours(14, 0, 0, 0);
	const oneOnOneEnd = new Date(oneOnOne);
	oneOnOneEnd.setUTCMinutes(30);

	await putObject(
		db,
		schedule.id,
		"demo-event-2",
		makeVevent("demo-event-2", "1on1ミーティング", {
			dtstart: formatDate(oneOnOne),
			dtend: formatDate(oneOnOneEnd),
			rrule: "FREQ=WEEKLY;BYDAY=TU",
		}),
	);

}
