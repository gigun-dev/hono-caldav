/**
 * Google Calendar API client using fetch().
 * Provides free/busy queries and event listing.
 */

export type FreeBusySlot = {
	start: string;
	end: string;
};

export type GoogleCalendarEvent = {
	id: string;
	summary: string;
	start: string;
	end: string;
	status: string;
};

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

/**
 * Query Google Calendar free/busy information.
 * @param accessToken - Google OAuth access token with calendar.readonly scope
 * @param calendarId - Calendar ID (e.g., "primary" or email address)
 * @param timeMin - Start of time range (ISO format)
 * @param timeMax - End of time range (ISO format)
 */
export async function getFreeBusy(
	accessToken: string,
	calendarId: string,
	timeMin: string,
	timeMax: string,
): Promise<FreeBusySlot[]> {
	const res = await fetch(`${CALENDAR_API_BASE}/freeBusy`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			timeMin,
			timeMax,
			items: [{ id: calendarId }],
		}),
	});

	if (!res.ok) {
		const errorText = await res.text();
		throw new Error(
			`Google Calendar freeBusy error: ${res.status} ${errorText}`,
		);
	}

	const data = (await res.json()) as FreeBusyResponse;
	const calendarBusy = data.calendars?.[calendarId]?.busy ?? [];
	return calendarBusy.map((slot) => ({
		start: slot.start,
		end: slot.end,
	}));
}

/**
 * List events from a Google Calendar.
 * @param accessToken - Google OAuth access token with calendar.readonly scope
 * @param calendarId - Calendar ID (e.g., "primary" or email address)
 * @param timeMin - Start of time range (ISO format)
 * @param timeMax - End of time range (ISO format)
 */
export async function listEvents(
	accessToken: string,
	calendarId: string,
	timeMin: string,
	timeMax: string,
): Promise<GoogleCalendarEvent[]> {
	const params = new URLSearchParams({
		timeMin,
		timeMax,
		singleEvents: "true",
		orderBy: "startTime",
	});

	const res = await fetch(
		`${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
		{
			headers: { Authorization: `Bearer ${accessToken}` },
		},
	);

	if (!res.ok) {
		const errorText = await res.text();
		throw new Error(
			`Google Calendar events error: ${res.status} ${errorText}`,
		);
	}

	const data = (await res.json()) as EventsListResponse;
	return (data.items ?? []).map((item) => ({
		id: item.id,
		summary: item.summary ?? "",
		start: item.start?.dateTime ?? item.start?.date ?? "",
		end: item.end?.dateTime ?? item.end?.date ?? "",
		status: item.status ?? "confirmed",
	}));
}

/**
 * Parse a free/busy API response. Exported for testing.
 */
export function parseFreeBusyResponse(
	data: FreeBusyResponse,
	calendarId: string,
): FreeBusySlot[] {
	const calendarBusy = data.calendars?.[calendarId]?.busy ?? [];
	return calendarBusy.map((slot) => ({
		start: slot.start,
		end: slot.end,
	}));
}

/**
 * Parse an events list API response. Exported for testing.
 */
export function parseEventsListResponse(
	data: EventsListResponse,
): GoogleCalendarEvent[] {
	return (data.items ?? []).map((item) => ({
		id: item.id,
		summary: item.summary ?? "",
		start: item.start?.dateTime ?? item.start?.date ?? "",
		end: item.end?.dateTime ?? item.end?.date ?? "",
		status: item.status ?? "confirmed",
	}));
}

// --- Google Calendar API response types ---

export type FreeBusyResponse = {
	kind: string;
	timeMin: string;
	timeMax: string;
	calendars?: Record<
		string,
		{
			busy: { start: string; end: string }[];
			errors?: { domain: string; reason: string }[];
		}
	>;
};

export type EventsListResponse = {
	kind: string;
	items?: {
		id: string;
		summary?: string;
		start?: { dateTime?: string; date?: string };
		end?: { dateTime?: string; date?: string };
		status?: string;
	}[];
};
