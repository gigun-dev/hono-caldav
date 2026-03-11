/**
 * Tier-based usage limits for Free / Pro plans.
 * Stripe integration is skeleton-only (no API key required).
 */

export interface TierLimits {
	maxCalendars: number;
	maxObjectsPerCalendar: number;
	gmailPolling: boolean;
	webhooksEnabled: boolean;
}

const VALID_TIERS = ["free", "pro"] as const;
type Tier = (typeof VALID_TIERS)[number];

function sanitizeTier(tier: string | undefined | null): Tier {
	if (tier && VALID_TIERS.includes(tier as Tier)) return tier as Tier;
	return "free";
}

export const TIER_LIMITS: Record<string, TierLimits> = {
	free: {
		maxCalendars: 3,
		maxObjectsPerCalendar: 100,
		gmailPolling: false,
		webhooksEnabled: false,
	},
	pro: {
		maxCalendars: -1, // unlimited
		maxObjectsPerCalendar: -1, // unlimited
		gmailPolling: true,
		webhooksEnabled: true,
	},
};

/**
 * Get the tier for a user. Defaults to 'free' if no row exists.
 */
export async function getUserTier(
	db: D1Database,
	userId: string,
): Promise<string> {
	const row = await db
		.prepare("SELECT tier FROM user_tiers WHERE user_id = ?")
		.bind(userId)
		.first<{ tier: string }>();
	return sanitizeTier(row?.tier);
}

/**
 * Get full tier info including Stripe IDs.
 */
export async function getUserTierInfo(
	db: D1Database,
	userId: string,
): Promise<{
	tier: string;
	limits: TierLimits;
	stripeCustomerId: string | null;
	stripeSubscriptionId: string | null;
}> {
	const row = await db
		.prepare(
			"SELECT tier, stripe_customer_id, stripe_subscription_id FROM user_tiers WHERE user_id = ?",
		)
		.bind(userId)
		.first<{
			tier: string;
			stripe_customer_id: string | null;
			stripe_subscription_id: string | null;
		}>();

	const tier = sanitizeTier(row?.tier);
	return {
		tier,
		limits: TIER_LIMITS[tier]!,
		stripeCustomerId: row?.stripe_customer_id ?? null,
		stripeSubscriptionId: row?.stripe_subscription_id ?? null,
	};
}

/**
 * Check whether the user can create another calendar.
 * Returns true if allowed, false if limit exceeded.
 */
export async function checkCalendarLimit(
	db: D1Database,
	userId: string,
): Promise<boolean> {
	const tier = await getUserTier(db, userId);
	const limits = TIER_LIMITS[tier]!;

	if (limits.maxCalendars === -1) return true; // unlimited

	const row = await db
		.prepare(
			"SELECT COUNT(*) AS cnt FROM calendars WHERE user_id = ?",
		)
		.bind(userId)
		.first<{ cnt: number }>();
	const count = row?.cnt ?? 0;
	return count < limits.maxCalendars;
}

/**
 * Check whether the user can add another object to the given calendar.
 * Returns true if allowed, false if limit exceeded.
 */
export async function checkObjectLimit(
	db: D1Database,
	userId: string,
	calendarId: number,
): Promise<boolean> {
	const tier = await getUserTier(db, userId);
	const limits = TIER_LIMITS[tier]!;

	if (limits.maxObjectsPerCalendar === -1) return true; // unlimited

	const row = await db
		.prepare(
			"SELECT COUNT(*) AS cnt FROM calendar_objects WHERE calendar_id = ?",
		)
		.bind(calendarId)
		.first<{ cnt: number }>();
	const count = row?.cnt ?? 0;
	return count < limits.maxObjectsPerCalendar;
}

/**
 * Set user tier (used by Stripe webhook handler or admin).
 */
export async function setUserTier(
	db: D1Database,
	userId: string,
	tier: string, // validated below
	stripeCustomerId?: string | null,
	stripeSubscriptionId?: string | null,
): Promise<void> {
	if (!VALID_TIERS.includes(tier as Tier)) {
		throw new Error(`Invalid tier: ${tier}. Must be one of: ${VALID_TIERS.join(", ")}`);
	}
	await db
		.prepare(
			`INSERT INTO user_tiers (user_id, tier, stripe_customer_id, stripe_subscription_id, tier_updated_at)
			 VALUES (?, ?, ?, ?, datetime('now'))
			 ON CONFLICT(user_id) DO UPDATE SET
			   tier = excluded.tier,
			   stripe_customer_id = COALESCE(excluded.stripe_customer_id, user_tiers.stripe_customer_id),
			   stripe_subscription_id = COALESCE(excluded.stripe_subscription_id, user_tiers.stripe_subscription_id),
			   tier_updated_at = datetime('now')`,
		)
		.bind(
			userId,
			tier,
			stripeCustomerId ?? null,
			stripeSubscriptionId ?? null,
		)
		.run();
}

/**
 * Skeleton: Create a Stripe checkout session for upgrading to Pro.
 * In production this would call the Stripe API.
 */
export async function createStripeCheckoutSession(
	_userId: string,
	_returnUrl: string,
): Promise<{ url: string }> {
	// Skeleton: In production, call Stripe API to create a checkout session
	// const stripe = new Stripe(env.STRIPE_SECRET_KEY);
	// const session = await stripe.checkout.sessions.create({ ... });
	// return { url: session.url };
	return {
		url: "https://checkout.stripe.com/placeholder-session",
	};
}

/**
 * Skeleton: Handle Stripe webhook events (subscription created/cancelled).
 * In production this would verify the webhook signature and update the tier.
 */
export async function handleStripeWebhook(
	_db: D1Database,
	_payload: string,
	_signature: string,
): Promise<{ handled: boolean }> {
	// Skeleton: In production, verify signature and process events
	// const event = stripe.webhooks.constructEvent(payload, signature, webhookSecret);
	// switch (event.type) {
	//   case 'checkout.session.completed': ...
	//   case 'customer.subscription.deleted': ...
	// }
	return { handled: false };
}
