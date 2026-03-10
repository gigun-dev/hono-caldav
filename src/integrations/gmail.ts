/**
 * Lightweight Gmail API client using fetch().
 * Fetches recent emails and extracts subject/body for task extraction.
 */

export type GmailMessage = {
	id: string;
	subject: string;
	from: string;
	date: string;
	bodyText: string;
};

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/**
 * Fetch recent emails from Gmail API.
 * @param accessToken - Google OAuth access token with gmail.readonly scope
 * @param maxResults - Maximum number of messages to fetch (default: 10)
 * @param after - ISO date string; only fetch emails after this date
 */
export async function fetchRecentEmails(
	accessToken: string,
	maxResults: number = 10,
	after?: string,
): Promise<GmailMessage[]> {
	const queryParts: string[] = [];
	if (after) {
		const d = new Date(after);
		const yyyy = d.getUTCFullYear();
		const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
		const dd = String(d.getUTCDate()).padStart(2, "0");
		queryParts.push(`after:${yyyy}/${mm}/${dd}`);
	}

	const params = new URLSearchParams({
		maxResults: String(maxResults),
	});
	if (queryParts.length > 0) {
		params.set("q", queryParts.join(" "));
	}

	const listRes = await fetch(`${GMAIL_API_BASE}/messages?${params}`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});

	if (!listRes.ok) {
		const errorText = await listRes.text();
		throw new Error(`Gmail API list error: ${listRes.status} ${errorText}`);
	}

	const listData = (await listRes.json()) as {
		messages?: { id: string; threadId: string }[];
	};

	if (!listData.messages || listData.messages.length === 0) {
		return [];
	}

	const messages: GmailMessage[] = [];
	for (const msg of listData.messages) {
		const detail = await fetchMessageDetail(accessToken, msg.id);
		if (detail) {
			messages.push(detail);
		}
	}

	return messages;
}

async function fetchMessageDetail(
	accessToken: string,
	messageId: string,
): Promise<GmailMessage | null> {
	const res = await fetch(
		`${GMAIL_API_BASE}/messages/${messageId}?format=full`,
		{
			headers: { Authorization: `Bearer ${accessToken}` },
		},
	);

	if (!res.ok) {
		console.error(`Gmail API message detail error: ${res.status}`);
		return null;
	}

	const data = (await res.json()) as GmailMessageResponse;
	return parseGmailMessage(data);
}

/**
 * Parse a Gmail API message response into our GmailMessage type.
 * Exported for testing.
 */
export function parseGmailMessage(data: GmailMessageResponse): GmailMessage {
	const headers = data.payload?.headers ?? [];
	const subject =
		headers.find((h) => h.name.toLowerCase() === "subject")?.value ?? "";
	const from =
		headers.find((h) => h.name.toLowerCase() === "from")?.value ?? "";
	const date =
		headers.find((h) => h.name.toLowerCase() === "date")?.value ?? "";

	const bodyText = extractBodyText(data.payload);

	return {
		id: data.id,
		subject,
		from,
		date,
		bodyText,
	};
}

function extractBodyText(
	payload: GmailMessageResponse["payload"],
): string {
	if (!payload) return "";

	// Check for direct body data (plain text)
	if (payload.mimeType === "text/plain" && payload.body?.data) {
		return base64UrlDecode(payload.body.data);
	}

	// Check parts for multipart messages
	if (payload.parts) {
		for (const part of payload.parts) {
			if (part.mimeType === "text/plain" && part.body?.data) {
				return base64UrlDecode(part.body.data);
			}
		}
		// Fallback: try HTML if no plain text
		for (const part of payload.parts) {
			if (part.mimeType === "text/html" && part.body?.data) {
				const html = base64UrlDecode(part.body.data);
				return stripHtml(html);
			}
		}
	}

	return "";
}

/**
 * Decode base64url-encoded string (Gmail API format).
 * Exported for testing.
 */
export function base64UrlDecode(data: string): string {
	const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
	const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
	const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
	return new TextDecoder().decode(bytes);
}

function stripHtml(html: string): string {
	return html
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n")
		.replace(/<[^>]*>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&#39;/g, "'")
		.replace(/&quot;/g, '"')
		.trim();
}

// --- Gmail API response types ---

export type GmailMessageResponse = {
	id: string;
	threadId: string;
	payload?: {
		mimeType: string;
		headers?: { name: string; value: string }[];
		body?: { data?: string; size: number };
		parts?: {
			mimeType: string;
			body?: { data?: string; size: number };
			parts?: {
				mimeType: string;
				body?: { data?: string; size: number };
			}[];
		}[];
	};
};
