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
		`SUMMARY:${event.summary}`,
		`ORGANIZER;CN=Scheduling:mailto:${event.organizerEmail}`,
		`SEQUENCE:${event.sequence ?? 0}`,
	];

	for (const attendee of event.attendees) {
		lines.push(
			`ATTENDEE;PARTSTAT=${attendee.partstat};RSVP=${attendee.rsvp ? "TRUE" : "FALSE"}:mailto:${attendee.email}`,
		);
	}

	if (event.description) lines.push(`DESCRIPTION:${event.description}`);
	if (event.location) lines.push(`LOCATION:${event.location}`);
	lines.push("END:VEVENT", "END:VCALENDAR");

	return lines.join("\r\n") + "\r\n";
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
		`SUMMARY:${event.summary}`,
		`ORGANIZER;CN=Scheduling:mailto:${event.organizerEmail}`,
		`SEQUENCE:${event.sequence ?? 0}`,
	];

	for (const attendee of event.attendees) {
		lines.push(
			`ATTENDEE;PARTSTAT=${attendee.partstat};RSVP=${attendee.rsvp ? "TRUE" : "FALSE"}:mailto:${attendee.email}`,
		);
	}

	if (event.description) lines.push(`DESCRIPTION:${event.description}`);
	if (event.location) lines.push(`LOCATION:${event.location}`);
	lines.push("END:VEVENT", "END:VCALENDAR");

	return lines.join("\r\n") + "\r\n";
}

/**
 * Parse an iTIP REPLY to extract PARTSTAT update.
 */
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

	return {
		uid,
		attendeeEmail: attendeeMatch[2].trim().toLowerCase(),
		partstat: attendeeMatch[1].trim(),
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

function formatTimestamp(date: Date): string {
	return date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

function extractProp(ics: string, propName: string): string | null {
	const regex = new RegExp(`^${propName}[^:]*:(.+)$`, "im");
	const match = ics.match(regex);
	return match?.[1]?.trim() ?? null;
}
