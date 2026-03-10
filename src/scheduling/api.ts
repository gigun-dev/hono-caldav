/**
 * Scheduling API handlers for iTIP event management.
 * Provides HTTP endpoints for creating events with attendees,
 * processing iTIP REPLYs, and handling COUNTERs.
 */

import type { Context } from "hono";
import { putObject, getObjectByUid } from "../caldav/storage.js";
import {
	addAttendees,
	getAttendees,
	updatePartstat,
	findObjectByUidGlobal,
	addFeedback,
} from "./storage.js";
import { sendItipRequestToAttendees } from "./email-sender.js";
import {
	generateVeventIcs,
	generateItipRequest,
	parseItipReply,
	parseItipCounter,
	type EventInfo,
	type AttendeeInfo,
} from "./itip.js";

const SCHEDULING_EMAIL = "scheduling@localhost"; // Override via env

/**
 * Create an event with attendees (SaaS as Organizer).
 * POST /api/scheduling/events
 * Body: { calendarId, summary, dtstart, dtend, attendees: [email], description?, location? }
 */
export async function createScheduledEvent(
	c: Context<{ Bindings: CloudflareBindings }>,
	userId: string,
): Promise<Response> {
	const body = await c.req.json<{
		calendarId: number;
		summary: string;
		dtstart: string;
		dtend: string;
		attendees: string[];
		description?: string;
		location?: string;
	}>();

	const organizerEmail =
		(c.env as unknown as Record<string, string>).SCHEDULING_EMAIL ||
		SCHEDULING_EMAIL;

	const uid = `${crypto.randomUUID()}@${new URL(c.req.url).hostname}`;

	const attendeeInfos: AttendeeInfo[] = body.attendees.map((email) => ({
		email: email.toLowerCase(),
		partstat: "NEEDS-ACTION" as const,
		rsvp: true,
	}));

	const eventInfo: EventInfo = {
		uid,
		summary: body.summary,
		dtstart: body.dtstart,
		dtend: body.dtend,
		organizerEmail,
		attendees: attendeeInfos,
		description: body.description,
		location: body.location,
		sequence: 0,
	};

	// Store VEVENT in D1
	const ics = generateVeventIcs(eventInfo);
	const { object } = await putObject(c.env.DB, body.calendarId, uid, ics);

	// Store attendees in tracking table
	await addAttendees(
		c.env.DB,
		object.id,
		attendeeInfos.map((a) => ({ email: a.email })),
	);

	// Generate iTIP REQUEST for each attendee
	const itipRequest = generateItipRequest(eventInfo);

	// Send iMIP REQUEST emails via Resend if API key is configured
	let emailResults: { success: boolean; error?: string }[] = [];
	const resendApiKey = (c.env as unknown as Record<string, string>)
		.RESEND_API_KEY;
	if (resendApiKey) {
		emailResults = await sendItipRequestToAttendees(
			resendApiKey,
			organizerEmail,
			body.summary,
			itipRequest,
			body.attendees,
		);
	}

	return c.json({
		uid,
		objectId: object.id,
		attendees: attendeeInfos.map((a) => a.email),
		itipRequest, // Raw ICS for reference
		emailsSent: emailResults,
	});
}

/**
 * Process an iTIP REPLY (attendee responds to invitation).
 * POST /api/scheduling/reply
 * Body: { icsData: string } — raw iCalendar REPLY
 */
export async function processReply(
	c: Context<{ Bindings: CloudflareBindings }>,
): Promise<Response> {
	const { icsData } = await c.req.json<{ icsData: string }>();

	const reply = parseItipReply(icsData);
	if (!reply || reply.method !== "REPLY") {
		return c.json({ error: "Invalid iTIP REPLY" }, 400);
	}

	const VALID_PARTSTATS = new Set([
		"ACCEPTED",
		"DECLINED",
		"TENTATIVE",
		"NEEDS-ACTION",
		"DELEGATED",
	]);
	if (!VALID_PARTSTATS.has(reply.partstat)) {
		return c.json({ error: "Invalid PARTSTAT value" }, 400);
	}

	// Find the event by UID
	const obj = await findObjectByUidGlobal(c.env.DB, reply.uid);
	if (!obj) {
		return c.json({ error: "Event not found" }, 404);
	}

	// Update PARTSTAT in attendees table
	const updated = await updatePartstat(
		c.env.DB,
		obj.id,
		reply.attendeeEmail,
		reply.partstat,
	);

	if (!updated) {
		return c.json({ error: "Attendee not found" }, 404);
	}

	// Update PARTSTAT in the stored ICS data
	let updatedIcs = obj.icsData;
	const attendeeRegex = new RegExp(
		`(ATTENDEE[^:]*PARTSTAT=)[^;:\\r\\n]+([^:]*:mailto:${escapeRegex(reply.attendeeEmail)})`,
		"i",
	);
	updatedIcs = updatedIcs.replace(
		attendeeRegex,
		`$1${reply.partstat}$2`,
	);
	await putObject(c.env.DB, obj.calendarId, reply.uid, updatedIcs);

	// Track DECLINED feedback for analytics
	if (reply.partstat === "DECLINED") {
		const dtstartMatch = obj.icsData.match(/DTSTART[^:]*:(.+)/i);
		const dtendMatch = obj.icsData.match(/DTEND[^:]*:(.+)/i);

		await addFeedback(c.env.DB, {
			calendarObjectId: obj.id,
			attendeeEmail: reply.attendeeEmail,
			feedbackType: "DECLINED",
			originalDtstart: dtstartMatch?.[1]?.trim() ?? null,
			originalDtend: dtendMatch?.[1]?.trim() ?? null,
			proposedDtstart: null,
			proposedDtend: null,
		});
	}

	return c.json({
		uid: reply.uid,
		attendee: reply.attendeeEmail,
		partstat: reply.partstat,
	});
}

/**
 * Process an iTIP COUNTER (attendee proposes new time).
 * Auto-ACCEPT: update event and send new REQUEST to all attendees.
 * POST /api/scheduling/counter
 * Body: { icsData: string } — raw iCalendar COUNTER
 */
export async function processCounter(
	c: Context<{ Bindings: CloudflareBindings }>,
): Promise<Response> {
	const { icsData } = await c.req.json<{ icsData: string }>();

	const counter = parseItipCounter(icsData);
	if (!counter) {
		return c.json({ error: "Invalid iTIP COUNTER" }, 400);
	}

	// Find the event
	const obj = await findObjectByUidGlobal(c.env.DB, counter.uid);
	if (!obj) {
		return c.json({ error: "Event not found" }, 404);
	}

	// Auto-ACCEPT: update DTSTART/DTEND and increment SEQUENCE
	let updatedIcs = obj.icsData;
	updatedIcs = updatedIcs.replace(
		/DTSTART[^:]*:.+/i,
		`DTSTART:${counter.newDtstart}`,
	);
	updatedIcs = updatedIcs.replace(
		/DTEND[^:]*:.+/i,
		`DTEND:${counter.newDtend}`,
	);

	// Increment SEQUENCE
	const seqMatch = updatedIcs.match(/SEQUENCE:(\d+)/);
	const currentSeq = seqMatch ? parseInt(seqMatch[1], 10) : 0;
	if (seqMatch) {
		updatedIcs = updatedIcs.replace(
			/SEQUENCE:\d+/,
			`SEQUENCE:${currentSeq + 1}`,
		);
	} else {
		updatedIcs = updatedIcs.replace(
			"END:VEVENT",
			`SEQUENCE:${currentSeq + 1}\r\nEND:VEVENT`,
		);
	}

	// Update DTSTAMP
	const now = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
	updatedIcs = updatedIcs.replace(/DTSTAMP[^:]*:.+/i, `DTSTAMP:${now}`);

	await putObject(c.env.DB, obj.calendarId, counter.uid, updatedIcs);

	// Get attendees to notify
	const attendees = await getAttendees(c.env.DB, obj.id);

	// Generate new REQUEST with updated times
	const organizerMatch = updatedIcs.match(/ORGANIZER[^:]*:mailto:([^\r\n]+)/i);
	const organizerEmail = organizerMatch?.[1]?.trim() ?? SCHEDULING_EMAIL;
	const summaryMatch = updatedIcs.match(/SUMMARY:(.+)/i);
	const summary = summaryMatch?.[1]?.trim() ?? "Event";

	const eventInfo: EventInfo = {
		uid: counter.uid,
		summary,
		dtstart: counter.newDtstart,
		dtend: counter.newDtend,
		organizerEmail,
		attendees: attendees.map((a) => ({
			email: a.email,
			partstat: a.email === counter.attendeeEmail ? "ACCEPTED" : ("NEEDS-ACTION" as const),
			rsvp: a.email !== counter.attendeeEmail,
		})),
		sequence: currentSeq + 1,
	};

	const newRequest = generateItipRequest(eventInfo);

	// Send updated REQUEST to all attendees via Resend
	let emailResults: { success: boolean; error?: string }[] = [];
	const resendApiKey = (c.env as unknown as Record<string, string>)
		.RESEND_API_KEY;
	if (resendApiKey && attendees.length > 0) {
		emailResults = await sendItipRequestToAttendees(
			resendApiKey,
			organizerEmail,
			summary,
			newRequest,
			attendees.map((a) => a.email),
		);
	}

	// Update PARTSTAT in DB: counter proposer → ACCEPTED, others → NEEDS-ACTION
	await updatePartstat(c.env.DB, obj.id, counter.attendeeEmail, "ACCEPTED");
	for (const a of attendees) {
		if (a.email !== counter.attendeeEmail) {
			await updatePartstat(c.env.DB, obj.id, a.email, "NEEDS-ACTION");
		}
	}

	// Store COUNTER feedback
	await addFeedback(c.env.DB, {
		calendarObjectId: obj.id,
		attendeeEmail: counter.attendeeEmail,
		feedbackType: "COUNTER",
		originalDtstart: null,
		originalDtend: null,
		proposedDtstart: counter.newDtstart,
		proposedDtend: counter.newDtend,
	});

	return c.json({
		uid: counter.uid,
		counterFrom: counter.attendeeEmail,
		newDtstart: counter.newDtstart,
		newDtend: counter.newDtend,
		sequence: currentSeq + 1,
		itipRequest: newRequest,
		attendeesToNotify: attendees.map((a) => a.email),
		emailsSent: emailResults,
	});
}

/**
 * Get attendee status for an event.
 * GET /api/scheduling/events/:uid/attendees
 */
export async function getEventAttendees(
	c: Context<{ Bindings: CloudflareBindings }>,
): Promise<Response> {
	const uid = c.req.param("uid");
	const obj = await findObjectByUidGlobal(c.env.DB, uid);
	if (!obj) {
		return c.json({ error: "Event not found" }, 404);
	}

	const attendees = await getAttendees(c.env.DB, obj.id);
	return c.json({
		uid,
		attendees: attendees.map((a) => ({
			email: a.email,
			partstat: a.partstat,
			sentAt: a.sentAt,
			repliedAt: a.repliedAt,
		})),
	});
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
