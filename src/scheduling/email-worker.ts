/**
 * Cloudflare Email Worker for receiving iMIP REPLY and COUNTER emails.
 * This is exported as the `email` handler alongside the main fetch handler.
 */

import PostalMime from "postal-mime";
import { parseItipReply, parseItipCounter } from "./itip.js";
import {
	findObjectByUidGlobal,
	updatePartstat,
	getAttendees,
	addFeedback,
} from "./storage.js";
import { putObject } from "../caldav/storage.js";
import { generateItipRequest, type EventInfo } from "./itip.js";
import { sendItipRequestToAttendees } from "./email-sender.js";

type EmailEnv = {
	DB: D1Database;
	RESEND_API_KEY?: string;
	SCHEDULING_EMAIL?: string;
};

/**
 * Cloudflare Email Worker handler.
 * Receives iMIP emails, parses calendar data, and updates event state.
 */
export async function handleEmail(
	message: ForwardableEmailMessage,
	env: EmailEnv,
): Promise<void> {
	const parser = new PostalMime();
	const rawResponse = new Response(message.raw);
	const email = await parser.parse(await rawResponse.arrayBuffer());

	// Find text/calendar part — check attachments and content type
	let icsData: string | null = null;

	// Check attachments
	const calendarAttachment = email.attachments?.find(
		(a) => a.mimeType?.includes("text/calendar"),
	);
	if (calendarAttachment) {
		icsData = new TextDecoder().decode(calendarAttachment.content);
	}

	// Also check if body content-type is text/calendar
	if (!icsData && email.text && email.headers) {
		const ct = email.headers.find(
			(h) => h.key === "content-type" && h.value.includes("text/calendar"),
		);
		if (ct) {
			icsData = email.text;
		}
	}

	if (!icsData) {
		console.log("[Email Worker] No text/calendar part found, ignoring.");
		return;
	}

	console.log(`[Email Worker] Received iMIP from ${message.from}`);

	// Try parsing as REPLY first
	const reply = parseItipReply(icsData);
	if (reply && reply.method === "REPLY") {
		await handleReply(env.DB, reply, icsData);
		return;
	}

	// Try parsing as COUNTER
	const counter = parseItipCounter(icsData);
	if (counter) {
		await handleCounter(env, counter);
		return;
	}

	console.log("[Email Worker] Unrecognized iTIP method, ignoring.");
}

async function handleReply(
	db: D1Database,
	reply: { uid: string; attendeeEmail: string; partstat: string },
	icsData: string,
): Promise<void> {
	const obj = await findObjectByUidGlobal(db, reply.uid);
	if (!obj) {
		console.log(`[Email Worker] Event not found for UID: ${reply.uid}`);
		return;
	}

	// Update PARTSTAT in attendees table
	const updated = await updatePartstat(
		db,
		obj.id,
		reply.attendeeEmail,
		reply.partstat,
	);

	if (!updated) {
		console.log(`[Email Worker] Attendee not found: ${reply.attendeeEmail}`);
		return;
	}

	// Update PARTSTAT in stored ICS using line-based parsing
	const updatedIcs = updateAttendeePartstat(
		obj.icsData,
		reply.attendeeEmail,
		reply.partstat,
	);
	await putObject(db, obj.calendarId, reply.uid, updatedIcs);

	// Track DECLINED feedback
	if (reply.partstat === "DECLINED") {
		// Extract original times from stored ICS
		const dtstartMatch = obj.icsData.match(/DTSTART[^:]*:(.+)/i);
		const dtendMatch = obj.icsData.match(/DTEND[^:]*:(.+)/i);

		await addFeedback(db, {
			calendarObjectId: obj.id,
			attendeeEmail: reply.attendeeEmail,
			feedbackType: "DECLINED",
			originalDtstart: dtstartMatch?.[1]?.trim() ?? null,
			originalDtend: dtendMatch?.[1]?.trim() ?? null,
			proposedDtstart: null,
			proposedDtend: null,
		});
	}

	console.log(
		`[Email Worker] Updated ${reply.attendeeEmail} → ${reply.partstat} for ${reply.uid}`,
	);
}

async function handleCounter(
	env: EmailEnv,
	counter: {
		uid: string;
		attendeeEmail: string;
		newDtstart: string;
		newDtend: string;
	},
): Promise<void> {
	const obj = await findObjectByUidGlobal(env.DB, counter.uid);
	if (!obj) {
		console.log(`[Email Worker] Event not found for COUNTER UID: ${counter.uid}`);
		return;
	}

	// Extract original times for feedback before updating
	const origDtstartMatch = obj.icsData.match(/DTSTART[^:]*:(.+)/i);
	const origDtendMatch = obj.icsData.match(/DTEND[^:]*:(.+)/i);

	// Store COUNTER feedback
	await addFeedback(env.DB, {
		calendarObjectId: obj.id,
		attendeeEmail: counter.attendeeEmail,
		feedbackType: "COUNTER",
		originalDtstart: origDtstartMatch?.[1]?.trim() ?? null,
		originalDtend: origDtendMatch?.[1]?.trim() ?? null,
		proposedDtstart: counter.newDtstart,
		proposedDtend: counter.newDtend,
	});

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

	await putObject(env.DB, obj.calendarId, counter.uid, updatedIcs);

	// Update PARTSTAT in DB: counter proposer → ACCEPTED, others → NEEDS-ACTION
	const attendees = await getAttendees(env.DB, obj.id);
	await updatePartstat(env.DB, obj.id, counter.attendeeEmail, "ACCEPTED");
	for (const a of attendees) {
		if (a.email !== counter.attendeeEmail) {
			await updatePartstat(env.DB, obj.id, a.email, "NEEDS-ACTION");
		}
	}

	// Send updated REQUEST to all attendees

	if (env.RESEND_API_KEY && attendees.length > 0) {
		const organizerMatch = updatedIcs.match(
			/ORGANIZER[^:]*:mailto:([^\r\n]+)/i,
		);
		const organizerEmail =
			organizerMatch?.[1]?.trim() ??
			env.SCHEDULING_EMAIL ??
			"scheduling@localhost";
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
				partstat:
					a.email === counter.attendeeEmail
						? ("ACCEPTED" as const)
						: ("NEEDS-ACTION" as const),
				rsvp: a.email !== counter.attendeeEmail,
			})),
			sequence: currentSeq + 1,
		};

		const newRequest = generateItipRequest(eventInfo);
		await sendItipRequestToAttendees(
			env.RESEND_API_KEY,
			organizerEmail,
			summary,
			newRequest,
			attendees.map((a) => a.email),
		);
	}

	console.log(
		`[Email Worker] Auto-accepted COUNTER from ${counter.attendeeEmail} for ${counter.uid}`,
	);
}

function updateAttendeePartstat(
	icsData: string,
	email: string,
	newPartstat: string,
): string {
	const emailLower = email.toLowerCase();
	const lines = icsData.split(/\r?\n/);
	const result: string[] = [];

	for (const line of lines) {
		if (
			line.toUpperCase().startsWith("ATTENDEE") &&
			line.toLowerCase().includes(`mailto:${emailLower}`)
		) {
			if (/PARTSTAT=/i.test(line)) {
				result.push(
					line.replace(/PARTSTAT=[^;:\r\n]+/i, `PARTSTAT=${newPartstat}`),
				);
			} else {
				result.push(
					line.replace(/(:mailto:)/i, `;PARTSTAT=${newPartstat}$1`),
				);
			}
		} else {
			result.push(line);
		}
	}

	return result.join("\r\n");
}
