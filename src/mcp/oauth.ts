/**
 * MCP OAuth 2.0 Authorization Code Flow + PKCE
 * D1-based implementation for Cloudflare Workers.
 */

import type { Context } from "hono";

// --- PKCE helpers ---

export async function verifyCodeChallenge(
	codeVerifier: string,
	codeChallenge: string,
	method: string,
): Promise<boolean> {
	if (method === "S256") {
		const hash = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(codeVerifier),
		);
		const expected = btoa(String.fromCharCode(...new Uint8Array(hash)))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
		return expected === codeChallenge;
	}
	// plain
	return codeVerifier === codeChallenge;
}

function generateToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// --- Handlers ---

/**
 * GET /mcp/authorize
 * Requires authenticated session (authGuard).
 * Generates an authorization code and redirects to redirect_uri.
 */
export async function handleAuthorize(
	c: Context<{ Bindings: CloudflareBindings; Variables: { user: { id: string } } }>,
): Promise<Response> {
	const url = new URL(c.req.url);
	const clientId = url.searchParams.get("client_id");
	const redirectUri = url.searchParams.get("redirect_uri");
	const responseType = url.searchParams.get("response_type");
	const state = url.searchParams.get("state");
	const scope = url.searchParams.get("scope") || "read-write";
	const codeChallenge = url.searchParams.get("code_challenge");
	const codeChallengeMethod =
		url.searchParams.get("code_challenge_method") || "S256";

	// Validate required params
	if (responseType !== "code") {
		return c.json({ error: "unsupported_response_type" }, 400);
	}
	if (!clientId || !redirectUri) {
		return c.json({ error: "invalid_request", error_description: "client_id and redirect_uri are required" }, 400);
	}

	// Validate client
	const client = await c.env.DB.prepare(
		"SELECT id, redirect_uris FROM mcp_oauth_clients WHERE id = ?",
	)
		.bind(clientId)
		.first<{ id: string; redirect_uris: string }>();

	if (!client) {
		return c.json({ error: "invalid_client" }, 400);
	}

	// Validate redirect_uri
	const allowedUris: string[] = JSON.parse(client.redirect_uris);
	if (!allowedUris.includes(redirectUri)) {
		return c.json({ error: "invalid_redirect_uri" }, 400);
	}

	// Generate authorization code (10 min expiry)
	const code = generateToken();
	const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
	const user = c.get("user");

	await c.env.DB.prepare(
		`INSERT INTO mcp_oauth_codes (code, client_id, user_id, redirect_uri, code_challenge, code_challenge_method, scope, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			code,
			clientId,
			user.id,
			redirectUri,
			codeChallenge,
			codeChallengeMethod,
			scope,
			expiresAt,
		)
		.run();

	// Redirect with code
	const redirectUrl = new URL(redirectUri);
	redirectUrl.searchParams.set("code", code);
	if (state) {
		redirectUrl.searchParams.set("state", state);
	}
	return c.redirect(redirectUrl.toString());
}

/**
 * POST /mcp/token
 * Token endpoint: exchange code for tokens, or refresh.
 */
export async function handleToken(
	c: Context<{ Bindings: CloudflareBindings }>,
): Promise<Response> {
	let params: Record<string, string>;

	const contentType = c.req.header("content-type") || "";
	if (contentType.includes("application/json")) {
		params = await c.req.json();
	} else {
		const formData = await c.req.parseBody();
		params = {} as Record<string, string>;
		for (const [k, v] of Object.entries(formData)) {
			params[k] = String(v);
		}
	}

	const grantType = params.grant_type;

	if (grantType === "authorization_code") {
		return handleAuthorizationCodeGrant(c, params);
	} else if (grantType === "refresh_token") {
		return handleRefreshTokenGrant(c, params);
	}

	return c.json({ error: "unsupported_grant_type" }, 400);
}

async function handleAuthorizationCodeGrant(
	c: Context<{ Bindings: CloudflareBindings }>,
	params: Record<string, string>,
): Promise<Response> {
	const { code, redirect_uri, code_verifier, client_id } = params;

	if (!code) {
		return c.json({ error: "invalid_request", error_description: "code is required" }, 400);
	}

	// Look up the code
	const authCode = await c.env.DB.prepare(
		"SELECT * FROM mcp_oauth_codes WHERE code = ?",
	)
		.bind(code)
		.first<{
			code: string;
			client_id: string;
			user_id: string;
			redirect_uri: string;
			code_challenge: string | null;
			code_challenge_method: string;
			scope: string;
			expires_at: string;
			used: number;
		}>();

	if (!authCode) {
		return c.json({ error: "invalid_grant", error_description: "Invalid authorization code" }, 400);
	}

	// Check if already used
	if (authCode.used) {
		return c.json({ error: "invalid_grant", error_description: "Authorization code already used" }, 400);
	}

	// Check expiry
	if (new Date(authCode.expires_at) < new Date()) {
		return c.json({ error: "invalid_grant", error_description: "Authorization code expired" }, 400);
	}

	// Validate client_id
	if (client_id && client_id !== authCode.client_id) {
		return c.json({ error: "invalid_grant", error_description: "Client ID mismatch" }, 400);
	}

	// Validate redirect_uri
	if (redirect_uri && redirect_uri !== authCode.redirect_uri) {
		return c.json({ error: "invalid_grant", error_description: "Redirect URI mismatch" }, 400);
	}

	// PKCE verification
	if (authCode.code_challenge) {
		if (!code_verifier) {
			return c.json({ error: "invalid_grant", error_description: "code_verifier is required" }, 400);
		}
		const valid = await verifyCodeChallenge(
			code_verifier,
			authCode.code_challenge,
			authCode.code_challenge_method,
		);
		if (!valid) {
			return c.json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
		}
	}

	// Mark code as used
	await c.env.DB.prepare(
		"UPDATE mcp_oauth_codes SET used = 1 WHERE code = ?",
	)
		.bind(code)
		.run();

	// Generate tokens
	const accessToken = generateToken();
	const refreshToken = generateToken();
	const tokenId = crypto.randomUUID();
	const accessExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
	const refreshExpiresAt = new Date(
		Date.now() + 30 * 24 * 60 * 60 * 1000,
	).toISOString(); // 30 days

	await c.env.DB.prepare(
		`INSERT INTO mcp_oauth_tokens (id, client_id, user_id, access_token, refresh_token, scope, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			tokenId,
			authCode.client_id,
			authCode.user_id,
			accessToken,
			refreshToken,
			authCode.scope,
			accessExpiresAt,
		)
		.run();

	return c.json({
		access_token: accessToken,
		token_type: "Bearer",
		expires_in: 3600,
		refresh_token: refreshToken,
		scope: authCode.scope,
	});
}

async function handleRefreshTokenGrant(
	c: Context<{ Bindings: CloudflareBindings }>,
	params: Record<string, string>,
): Promise<Response> {
	const { refresh_token } = params;

	if (!refresh_token) {
		return c.json({ error: "invalid_request", error_description: "refresh_token is required" }, 400);
	}

	// Find the token record by refresh_token
	const tokenRecord = await c.env.DB.prepare(
		"SELECT * FROM mcp_oauth_tokens WHERE refresh_token = ? AND revoked = 0",
	)
		.bind(refresh_token)
		.first<{
			id: string;
			client_id: string;
			user_id: string;
			access_token: string;
			refresh_token: string;
			scope: string;
			expires_at: string;
			revoked: number;
		}>();

	if (!tokenRecord) {
		return c.json({ error: "invalid_grant", error_description: "Invalid refresh token" }, 400);
	}

	// Revoke old token
	await c.env.DB.prepare(
		"UPDATE mcp_oauth_tokens SET revoked = 1 WHERE id = ?",
	)
		.bind(tokenRecord.id)
		.run();

	// Issue new tokens
	const newAccessToken = generateToken();
	const newRefreshToken = generateToken();
	const newTokenId = crypto.randomUUID();
	const accessExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

	await c.env.DB.prepare(
		`INSERT INTO mcp_oauth_tokens (id, client_id, user_id, access_token, refresh_token, scope, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			newTokenId,
			tokenRecord.client_id,
			tokenRecord.user_id,
			newAccessToken,
			newRefreshToken,
			tokenRecord.scope,
			accessExpiresAt,
		)
		.run();

	return c.json({
		access_token: newAccessToken,
		token_type: "Bearer",
		expires_in: 3600,
		refresh_token: newRefreshToken,
		scope: tokenRecord.scope,
	});
}

/**
 * POST /mcp/revoke
 * Revoke an access or refresh token.
 */
export async function handleRevoke(
	c: Context<{ Bindings: CloudflareBindings }>,
): Promise<Response> {
	let params: Record<string, string>;

	const contentType = c.req.header("content-type") || "";
	if (contentType.includes("application/json")) {
		params = await c.req.json();
	} else {
		const formData = await c.req.parseBody();
		params = {} as Record<string, string>;
		for (const [k, v] of Object.entries(formData)) {
			params[k] = String(v);
		}
	}

	const token = params.token;
	if (!token) {
		// RFC 7009: respond 200 even if token not provided
		return c.json({});
	}

	// Try to revoke by access_token
	const byAccess = await c.env.DB.prepare(
		"UPDATE mcp_oauth_tokens SET revoked = 1 WHERE access_token = ?",
	)
		.bind(token)
		.run();

	if ((byAccess.meta?.changes ?? 0) === 0) {
		// Try by refresh_token
		await c.env.DB.prepare(
			"UPDATE mcp_oauth_tokens SET revoked = 1 WHERE refresh_token = ?",
		)
			.bind(token)
			.run();
	}

	return c.json({});
}

/**
 * Validate a Bearer token from MCP requests.
 * Returns { userId, scope } if valid, null otherwise.
 */
export async function validateMcpToken(
	db: D1Database,
	token: string,
): Promise<{ userId: string; scope: string } | null> {
	const record = await db
		.prepare(
			"SELECT user_id, scope, expires_at, revoked FROM mcp_oauth_tokens WHERE access_token = ?",
		)
		.bind(token)
		.first<{
			user_id: string;
			scope: string;
			expires_at: string;
			revoked: number;
		}>();

	if (!record) return null;
	if (record.revoked) return null;
	if (new Date(record.expires_at) < new Date()) return null;

	return { userId: record.user_id, scope: record.scope };
}
