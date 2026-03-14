/**
 * Build VTODO/VEVENT ICS from LLM extraction result (ExtractedScheduleTask / ExtractedScheduleEvent).
 * Used by cron/poll to persist extracted items into user_default_calendars.
 */

import type { ExtractedScheduleEvent, ExtractedScheduleTask } from "../types.js";

const CRLF = "\r\n";
const PRODID = "-//hono-caldav//LLM Extraction//EN";
const MAX_LINE_OCTETS = 75;

/** Current time in ICS format (UTC). */
function formatDtStamp(): string {
	const d = new Date();
	return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * Parse LLM date string (YYYY-MM-DD or YYYY-MM-DDTHH:mm) to ICS date or date-time.
 * Returns { type: 'date', value } or { type: 'datetime', value }.
 */
function parseExtractedDate(
	dateStr: string,
): { type: "date"; value: string } | { type: "datetime"; value: string } {
	const trimmed = (dateStr ?? "").trim();
	// YYYY-MM-DDTHH:mm or YYYY-MM-DDTHH:mm:ss
	const dateTimeMatch = trimmed.match(
		/^(\d{4})-(\d{2})-(\d{2})T(\d{1,2}):(\d{2})(?::(\d{2}))?/i,
	);
	if (dateTimeMatch) {
		const [, y, m, d, hh, mm, ss = "00"] = dateTimeMatch;
		return {
			type: "datetime",
			value: `${y}${m}${d}T${hh.padStart(2, "0")}${mm}${ss}`,
		};
	}
	// YYYY-MM-DD
	const dateMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
	if (dateMatch) {
		const [, y, m, d] = dateMatch;
		return { type: "date", value: `${y}${m}${d}` };
	}
	return { type: "date", value: trimmed.replace(/-/g, "") || "19700101" };
}

/**
 * Build DTSTART/DTEND for an event. date is YYYY-MM-DD, startTime/endTime are HH:mm.
 * If no times: use DATE type (all-day). End date for all-day is next day (exclusive end).
 */
function eventDateTimes(event: ExtractedScheduleEvent): {
	dtstart: string;
	dtend: string;
} {
	const datePart = (event.date ?? "").trim().replace(/-/g, "");
	const ymd = datePart.slice(0, 8);
	const hasTime =
		event.startTime != null &&
		event.startTime !== "" &&
		event.endTime != null &&
		event.endTime !== "";

	if (hasTime) {
		const [sh, sm] = (event.startTime ?? "00:00").split(":").map((n) => n.padStart(2, "0"));
		const [eh, em] = (event.endTime ?? "00:00").split(":").map((n) => n.padStart(2, "0"));
		return {
			dtstart: `${ymd}T${sh}${sm}00`,
			dtend: `${ymd}T${eh}${em}00`,
		};
	}
	// All-day: DTEND is exclusive, so next day
	const next = new Date(`${event.date ?? "1970-01-01"}T00:00:00Z`);
	next.setUTCDate(next.getUTCDate() + 1);
	const endY = next.getUTCFullYear();
	const endM = String(next.getUTCMonth() + 1).padStart(2, "0");
	const endD = String(next.getUTCDate()).padStart(2, "0");
	return {
		dtstart: ymd,
		dtend: `${endY}${endM}${endD}`,
	};
}

/** Escape text for ICS (\, ;, , and newlines). */
function escapeIcsText(s: string): string {
	return s
		.replace(/\\/g, "\\\\")
		.replace(/;/g, "\\;")
		.replace(/,/g, "\\,")
		.replace(/\r\n/g, "\\n")
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\n");
}

/** Fold a long line per RFC 5545 (75 octets, continuation with CRLF + space). */
function foldLine(line: string): string {
	const octets = new TextEncoder().encode(line);
	if (octets.length <= MAX_LINE_OCTETS) return line;
	const out: string[] = [];
	let i = 0;
	while (i < octets.length) {
		const chunkEnd = Math.min(i + MAX_LINE_OCTETS, octets.length);
		const chunk = new TextDecoder().decode(octets.subarray(i, chunkEnd));
		out.push(out.length === 0 ? chunk : " " + chunk);
		i = chunkEnd;
	}
	return out.join(CRLF);
}

/** Format a property line and fold if needed. */
function prop(name: string, value: string): string {
	const raw = `${name}:${value}`;
	return foldLine(raw);
}

/**
 * Build VTODO ICS from one extracted task.
 */
export function extractedTaskToVtodoIcs(
	task: ExtractedScheduleTask,
	uid: string,
): string {
	const now = formatDtStamp();
	const lines: string[] = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		`PRODID:${PRODID}`,
		"BEGIN:VTODO",
		prop("UID", uid),
		`DTSTAMP:${now}`,
		prop("SUMMARY", escapeIcsText((task.title ?? "").trim() || "（無題）")),
	];

	const parsed = parseExtractedDate(task.date ?? "");
	if (parsed.type === "date") {
		lines.push(`DUE;VALUE=DATE:${parsed.value}`);
	} else {
		lines.push(`DUE:${parsed.value}`);
	}

	if (task.description) {
		lines.push(prop("DESCRIPTION", escapeIcsText(task.description)));
	}
	if (task.location) {
		lines.push(prop("LOCATION", escapeIcsText(task.location)));
	}

	lines.push("STATUS:NEEDS-ACTION");
	lines.push("END:VTODO", "END:VCALENDAR");
	return lines.join(CRLF);
}

/**
 * Build VEVENT ICS from one extracted event.
 */
export function extractedEventToVeventIcs(
	event: ExtractedScheduleEvent,
	uid: string,
): string {
	const now = formatDtStamp();
	const { dtstart, dtend } = eventDateTimes(event);
	const lines: string[] = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		`PRODID:${PRODID}`,
		"BEGIN:VEVENT",
		prop("UID", uid),
		`DTSTAMP:${now}`,
		prop("SUMMARY", escapeIcsText((event.title ?? "").trim() || "（無題）")),
	];

	if (dtstart.length === 8) {
		lines.push("DTSTART;VALUE=DATE:" + dtstart);
		lines.push("DTEND;VALUE=DATE:" + dtend);
	} else {
		lines.push("DTSTART:" + dtstart);
		lines.push("DTEND:" + dtend);
	}

	if (event.description) {
		lines.push(prop("DESCRIPTION", escapeIcsText(event.description)));
	}
	if (event.location) {
		lines.push(prop("LOCATION", escapeIcsText(event.location)));
	}

	lines.push("END:VEVENT", "END:VCALENDAR");
	return lines.join(CRLF);
}
