/**
 * iTIP (RFC 5546) handling for "SaaS as Organizer" model.
 * Generates iCalendar objects with METHOD for iMIP transport.
 */

export type AttendeeInfo = {
	email: string;
	partstat: "NEEDS-ACTION" | "ACCEPTED" | "DECLINED" | "TENTATIVE";
	rsvp: boolean;
};

export type EventInfo = {
	uid: string;
	summary: string;
	dtstart: string;
	dtend: string;
	organizerEmail: string;
	attendees: AttendeeInfo[];
	description?: string;
	location?: string;
	sequence?: number;
};

/**
 * Generate a VEVENT with ORGANIZER and ATTENDEE(s) for storing in D1.
 */
export function generateVeventIcs(event: EventInfo): string {
	const now = formatTimestamp(new Date());
	const lines = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//hono-caldav//iTIP//EN",
		"BEGIN:VEVENT",
		`UID:${event.uid}`,
		`DTSTAMP:${now}`,
		`DTSTART:${event.dtstart}`,
		`DTEND:${event.dtend}`,
		`SUMMARY:${escapeIcsText(event.summary)}`,
		`ORGANIZER;CN=Scheduling:mailto:${event.organizerEmail}`,
		`SEQUENCE:${event.sequence ?? 0}`,
	];

	for (const attendee of event.attendees) {
		lines.push(
			`ATTENDEE;PARTSTAT=${attendee.partstat};RSVP=${attendee.rsvp ? "TRUE" : "FALSE"}:mailto:${attendee.email}`,
		);
	}

	if (event.description)
		lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
	if (event.location)
		lines.push(`LOCATION:${escapeIcsText(event.location)}`);
	lines.push("END:VEVENT", "END:VCALENDAR");

	return foldIcsLines(lines.join("\r\n") + "\r\n");
}

/**
 * Generate an iMIP REQUEST message (iCalendar with METHOD:REQUEST).
 */
export function generateItipRequest(event: EventInfo): string {
	const now = formatTimestamp(new Date());
	const lines = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//hono-caldav//iTIP//EN",
		"METHOD:REQUEST",
		"BEGIN:VEVENT",
		`UID:${event.uid}`,
		`DTSTAMP:${now}`,
		`DTSTART:${event.dtstart}`,
		`DTEND:${event.dtend}`,
		`SUMMARY:${escapeIcsText(event.summary)}`,
		`ORGANIZER;CN=Scheduling:mailto:${event.organizerEmail}`,
		`SEQUENCE:${event.sequence ?? 0}`,
	];

	for (const attendee of event.attendees) {
		lines.push(
			`ATTENDEE;PARTSTAT=${attendee.partstat};RSVP=${attendee.rsvp ? "TRUE" : "FALSE"}:mailto:${attendee.email}`,
		);
	}

	if (event.description)
		lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
	if (event.location)
		lines.push(`LOCATION:${escapeIcsText(event.location)}`);
	lines.push("END:VEVENT", "END:VCALENDAR");

	return foldIcsLines(lines.join("\r\n") + "\r\n");
}

/**
 * Parse an iTIP REPLY to extract PARTSTAT update.
 */
const VALID_PARTSTATS = new Set([
	"ACCEPTED",
	"DECLINED",
	"TENTATIVE",
	"NEEDS-ACTION",
	"DELEGATED",
]);

export function parseItipReply(icsData: string): {
	uid: string;
	attendeeEmail: string;
	partstat: string;
	method: string;
} | null {
	const method = extractProp(icsData, "METHOD");
	if (!method) return null;

	const uid = extractProp(icsData, "UID");
	if (!uid) return null;

	// Extract ATTENDEE with PARTSTAT
	const attendeeMatch = icsData.match(
		/ATTENDEE[^:]*PARTSTAT=([^;:\r\n]+)[^:]*:mailto:([^\r\n]+)/i,
	);
	if (!attendeeMatch) return null;

	const partstat = attendeeMatch[1].trim();
	if (!VALID_PARTSTATS.has(partstat)) return null;

	return {
		uid,
		attendeeEmail: attendeeMatch[2].trim().toLowerCase(),
		partstat,
		method: method.trim(),
	};
}

/**
 * Parse a COUNTER proposal to extract new DTSTART/DTEND.
 */
export function parseItipCounter(icsData: string): {
	uid: string;
	attendeeEmail: string;
	newDtstart: string;
	newDtend: string;
} | null {
	const method = extractProp(icsData, "METHOD");
	if (method?.trim() !== "COUNTER") return null;

	const uid = extractProp(icsData, "UID");
	const dtstart = extractProp(icsData, "DTSTART");
	const dtend = extractProp(icsData, "DTEND");
	if (!uid || !dtstart || !dtend) return null;

	const attendeeMatch = icsData.match(
		/ATTENDEE[^:]*:mailto:([^\r\n]+)/i,
	);
	if (!attendeeMatch) return null;

	return {
		uid,
		attendeeEmail: attendeeMatch[1].trim().toLowerCase(),
		newDtstart: dtstart.trim(),
		newDtend: dtend.trim(),
	};
}

// --- Helpers ---

/**
 * Escape text values for ICS properties (RFC 5545 §3.3.11).
 */
function escapeIcsText(s: string): string {
	return s
		.replace(/\\/g, "\\\\")
		.replace(/;/g, "\\;")
		.replace(/,/g, "\\,")
		.replace(/\r?\n/g, "\\n");
}

function formatTimestamp(date: Date): string {
	return date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

/**
 * Fold ICS content lines exceeding 75 octets per RFC 5545 §3.1.
 */
function foldIcsLines(ics: string): string {
	return ics
		.split("\r\n")
		.map((line) => {
			if (new TextEncoder().encode(line).length <= 75) return line;
			const result: string[] = [];
			let remaining = line;
			let first = true;
			while (new TextEncoder().encode(remaining).length > 75) {
				// Find safe cut point at 75 bytes (first line) or 74 (continuation)
				const limit = first ? 75 : 74;
				let cut = limit;
				// Ensure we don't split a multi-byte char
				while (
					cut > 0 &&
					new TextEncoder().encode(remaining.slice(0, cut)).length > limit
				) {
					cut--;
				}
				result.push((first ? "" : " ") + remaining.slice(0, cut));
				remaining = remaining.slice(cut);
				first = false;
			}
			if (remaining) result.push((first ? "" : " ") + remaining);
			return result.join("\r\n");
		})
		.join("\r\n");
}

function extractProp(ics: string, propName: string): string | null {
	// Unfold lines first (RFC 5545 §3.1: CRLF + space/tab = continuation)
	const unfolded = ics.replace(/\r?\n[ \t]/g, "");
	const regex = new RegExp(`^${propName}[^:]*:(.+)$`, "im");
	const match = unfolded.match(regex);
	return match?.[1]?.trim() ?? null;
}
