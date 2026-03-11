/**
 * Webhook notification system.
 * Fire-and-forget POST requests to registered webhook URLs
 * with HMAC-SHA256 signature verification.
 */

export type WebhookEvent = "create" | "update" | "delete";

export type WebhookPayload = {
	event: WebhookEvent;
	calendarId: number;
	uid: string;
	timestamp: string;
};

export type Webhook = {
	id: string;
	userId: string;
	url: string;
	events: string;
	secret: string;
	active: boolean;
	createdAt: string;
};

/**
 * Compute HMAC-SHA256 hex signature for a payload string.
 */
export async function computeHmacSignature(
	secret: string,
	body: string,
): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		encoder.encode(body),
	);
	return Array.from(new Uint8Array(signature), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
}

/**
 * Get active webhooks for a user that match a given event.
 */
export async function getMatchingWebhooks(
	db: D1Database,
	userId: string,
	event: WebhookEvent,
): Promise<Webhook[]> {
	const result = await db
		.prepare(
			"SELECT id, user_id, url, events, secret, active, created_at FROM webhooks WHERE user_id = ? AND active = 1",
		)
		.bind(userId)
		.all();
	const webhooks = (result.results ?? []).map(rowToWebhook);
	return webhooks.filter((w) => {
		const events = w.events.split(",").map((e) => e.trim());
		return events.includes(event);
	});
}

/**
 * Fire webhook notifications for a calendar event.
 * Returns a Promise that resolves when all notifications are sent.
 * In production, pass ctx to use waitUntil for fire-and-forget.
 */
export function fireWebhook(
	db: D1Database,
	userId: string,
	event: WebhookEvent,
	payload: Omit<WebhookPayload, "event" | "timestamp">,
	ctx?: ExecutionContext,
): Promise<void> {
	const fullPayload: WebhookPayload = {
		event,
		calendarId: payload.calendarId,
		uid: payload.uid,
		timestamp: new Date().toISOString(),
	};

	const work = async () => {
		try {
			const webhooks = await getMatchingWebhooks(db, userId, event);
			if (webhooks.length === 0) return;

			const body = JSON.stringify(fullPayload);

			const promises = webhooks.map(async (webhook) => {
				try {
					const signature = await computeHmacSignature(
						webhook.secret,
						body,
					);
					await fetch(webhook.url, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-Webhook-Signature": signature,
						},
						body,
					});
				} catch (err) {
					console.error(
						`[Webhook] Failed to notify ${webhook.url}:`,
						err,
					);
				}
			});

			await Promise.allSettled(promises);
		} catch (err) {
			console.error("[Webhook] Error in fireWebhook:", err);
		}
	};

	const promise = work();
	if (ctx) {
		ctx.waitUntil(promise);
	}
	return promise;
}

// --- Webhook CRUD ---

export async function createWebhook(
	db: D1Database,
	userId: string,
	url: string,
	events: string,
	secret: string,
): Promise<Webhook> {
	const result = await db
		.prepare(
			"INSERT INTO webhooks (user_id, url, events, secret) VALUES (?, ?, ?, ?) RETURNING id, user_id, url, events, secret, active, created_at",
		)
		.bind(userId, url, events, secret)
		.first();
	return rowToWebhook(result as Record<string, unknown>);
}

export async function listWebhooks(
	db: D1Database,
	userId: string,
): Promise<Webhook[]> {
	const result = await db
		.prepare(
			"SELECT id, user_id, url, events, secret, active, created_at FROM webhooks WHERE user_id = ? ORDER BY created_at DESC",
		)
		.bind(userId)
		.all();
	return (result.results ?? []).map(rowToWebhook);
}

export async function deleteWebhook(
	db: D1Database,
	userId: string,
	webhookId: string,
): Promise<boolean> {
	const existing = await db
		.prepare("SELECT id FROM webhooks WHERE id = ? AND user_id = ?")
		.bind(webhookId, userId)
		.first();
	if (!existing) return false;
	await db
		.prepare("DELETE FROM webhooks WHERE id = ? AND user_id = ?")
		.bind(webhookId, userId)
		.run();
	return true;
}

function rowToWebhook(row: Record<string, unknown>): Webhook {
	return {
		id: row.id as string,
		userId: row.user_id as string,
		url: row.url as string,
		events: row.events as string,
		secret: row.secret as string,
		active: Boolean(row.active),
		createdAt: row.created_at as string,
	};
}
