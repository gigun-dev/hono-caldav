/**
 * iMIP email sender using Resend API.
 * Sends iTIP REQUEST/CANCEL emails with text/calendar content.
 */

const RESEND_API_URL = "https://api.resend.com/emails";

export type ImipEmailOptions = {
	from: string;
	to: string;
	subject: string;
	icsData: string;
	method: "REQUEST" | "CANCEL";
};

export type SendResult = {
	success: boolean;
	id?: string;
	error?: string;
};

/**
 * Send an iMIP email via Resend API using plain fetch().
 */
export async function sendImipEmail(
	apiKey: string,
	options: ImipEmailOptions,
): Promise<SendResult> {
	const { from, to, subject, icsData, method } = options;

	// Build multipart email with text/calendar content
	// Resend expects attachments for calendar invites
	const body = {
		from,
		to: [to],
		subject,
		text: `You have been invited to: ${subject.replace(/^(Invitation|Cancelled): /, "")}`,
		attachments: [
			{
				filename: "invite.ics",
				content: btoa(icsData),
				content_type: `text/calendar; charset=UTF-8; method=${method}`,
			},
		],
		headers: {
			"Content-Type": `text/calendar; method=${method}`,
		},
	};

	const res = await fetch(RESEND_API_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	if (!res.ok) {
		const errText = await res.text();
		return { success: false, error: `Resend API error ${res.status}: ${errText}` };
	}

	const data = await res.json<{ id: string }>();
	return { success: true, id: data.id };
}

/**
 * Send iTIP REQUEST emails to all attendees for an event.
 */
export async function sendItipRequestToAttendees(
	apiKey: string,
	organizerEmail: string,
	summary: string,
	icsData: string,
	attendeeEmails: string[],
): Promise<SendResult[]> {
	const results: SendResult[] = [];

	for (const email of attendeeEmails) {
		const result = await sendImipEmail(apiKey, {
			from: organizerEmail,
			to: email,
			subject: `Invitation: ${summary}`,
			icsData,
			method: "REQUEST",
		});
		results.push(result);
	}

	return results;
}
