/**
 * Google OAuth token refresh helper.
 * Reads refresh token from better-auth's account table and obtains a new access token.
 */

type TokenResponse = {
	access_token: string;
	expires_in: number;
	token_type: string;
	scope?: string;
};

/**
 * Refresh the Google OAuth access token for a user.
 *
 * better-auth stores tokens in the `account` table:
 * - access_token, refresh_token, access_token_expires_at
 * - With `encryptOAuthTokens: true`, tokens are encrypted.
 *
 * TODO: If encryptOAuthTokens is enabled, tokens in the account table are
 * encrypted by better-auth using the BETTER_AUTH_SECRET. For now, this
 * function attempts to read them directly. If they are encrypted, you will
 * need to use better-auth's internal decryption or disable encryption.
 *
 * @param db - D1 database binding
 * @param userId - User ID (matches account.userId)
 * @param clientId - Google OAuth client ID
 * @param clientSecret - Google OAuth client secret
 * @returns New access token, or null if refresh failed
 */
export async function refreshAccessToken(
	db: D1Database,
	userId: string,
	clientId: string,
	clientSecret: string,
): Promise<string | null> {
	// Read refresh token from better-auth's account table
	const account = await db
		.prepare(
			"SELECT id, refresh_token, access_token FROM account WHERE user_id = ? AND provider_id = 'google'",
		)
		.bind(userId)
		.first<{
			id: string;
			refresh_token: string | null;
			access_token: string | null;
		}>();

	if (!account?.refresh_token) {
		console.error(
			`[google-auth] No refresh token found for user ${userId}`,
		);
		return null;
	}

	// Exchange refresh token for new access token
	const res = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			refresh_token: account.refresh_token,
			grant_type: "refresh_token",
		}),
	});

	if (!res.ok) {
		const errorText = await res.text();
		console.error(
			`[google-auth] Token refresh failed: ${res.status} ${errorText}`,
		);
		return null;
	}

	const tokenData = (await res.json()) as TokenResponse;

	// Update access token in the account table
	const expiresAt = new Date(
		Date.now() + tokenData.expires_in * 1000,
	).toISOString();

	await db
		.prepare(
			"UPDATE account SET access_token = ?, access_token_expires_at = ? WHERE id = ?",
		)
		.bind(tokenData.access_token, expiresAt, account.id)
		.run();

	return tokenData.access_token;
}

/**
 * Get a valid access token for a user, refreshing if needed.
 */
export async function getValidAccessToken(
	db: D1Database,
	userId: string,
	clientId: string,
	clientSecret: string,
): Promise<string | null> {
	const account = await db
		.prepare(
			"SELECT access_token, access_token_expires_at FROM account WHERE user_id = ? AND provider_id = 'google'",
		)
		.bind(userId)
		.first<{
			access_token: string | null;
			access_token_expires_at: string | null;
		}>();

	if (!account?.access_token) {
		return refreshAccessToken(db, userId, clientId, clientSecret);
	}

	// Check if token is about to expire (5 minute buffer)
	if (account.access_token_expires_at) {
		const expiresAt = new Date(account.access_token_expires_at).getTime();
		if (Date.now() > expiresAt - 5 * 60 * 1000) {
			return refreshAccessToken(db, userId, clientId, clientSecret);
		}
	}

	return account.access_token;
}
