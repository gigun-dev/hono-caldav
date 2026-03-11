import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import "../src/index.js";
import {
	verifyCodeChallenge,
	validateMcpToken,
} from "../src/mcp/oauth.js";

const MCP_AUTH = "Bearer test-mcp-token";

// Helper: insert a test OAuth client
async function createTestClient(
	clientId = "test-client",
	redirectUris = ["http://localhost:3000/callback"],
	name = "Test Client",
) {
	await env.DB.prepare(
		"INSERT OR IGNORE INTO mcp_oauth_clients (id, redirect_uris, name) VALUES (?, ?, ?)",
	)
		.bind(clientId, JSON.stringify(redirectUris), name)
		.run();
}

// Helper: insert a test user into the better-auth user table
async function createTestUser(userId = "oauth-test-user") {
	await env.DB.prepare(
		"INSERT OR IGNORE INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))",
	)
		.bind(userId, "OAuth Test User", `${userId}@example.com`)
		.run();
}

// Helper: directly insert an authorization code (simulating what handleAuthorize does)
async function insertAuthCode(opts: {
	code: string;
	clientId: string;
	userId: string;
	redirectUri: string;
	codeChallenge?: string;
	codeChallengeMethod?: string;
	scope?: string;
	expiresAt?: string;
	used?: number;
}) {
	const expiresAt =
		opts.expiresAt || new Date(Date.now() + 10 * 60 * 1000).toISOString();
	await env.DB.prepare(
		`INSERT INTO mcp_oauth_codes (code, client_id, user_id, redirect_uri, code_challenge, code_challenge_method, scope, expires_at, used)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			opts.code,
			opts.clientId,
			opts.userId,
			opts.redirectUri,
			opts.codeChallenge || null,
			opts.codeChallengeMethod || "S256",
			opts.scope || "read-write",
			expiresAt,
			opts.used || 0,
		)
		.run();
}

// Helper: exchange code for tokens via /mcp/token
async function exchangeCode(params: Record<string, string>) {
	return SELF.fetch("http://localhost/mcp/token", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ grant_type: "authorization_code", ...params }),
	});
}

// PKCE helpers
async function generatePkce() {
	const verifier = crypto.randomUUID() + crypto.randomUUID();
	const hash = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(verifier),
	);
	const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	return { verifier, challenge };
}

describe("MCP OAuth - PKCE verification", () => {
	it("verifies S256 code challenge correctly", async () => {
		const { verifier, challenge } = await generatePkce();
		const result = await verifyCodeChallenge(verifier, challenge, "S256");
		expect(result).toBe(true);
	});

	it("rejects wrong S256 code verifier", async () => {
		const { challenge } = await generatePkce();
		const result = await verifyCodeChallenge(
			"wrong-verifier",
			challenge,
			"S256",
		);
		expect(result).toBe(false);
	});

	it("verifies plain code challenge correctly", async () => {
		const result = await verifyCodeChallenge(
			"plain-verifier",
			"plain-verifier",
			"plain",
		);
		expect(result).toBe(true);
	});
});

describe("MCP OAuth - Token endpoint (authorization_code grant)", () => {
	const CLIENT_ID = "token-test-client";
	const USER_ID = "token-test-user";
	const REDIRECT_URI = "http://localhost:3000/callback";

	beforeAll(async () => {
		await createTestClient(CLIENT_ID, [REDIRECT_URI]);
		await createTestUser(USER_ID);
	});

	it("exchanges valid code for tokens", async () => {
		const code = crypto.randomUUID();
		await insertAuthCode({
			code,
			clientId: CLIENT_ID,
			userId: USER_ID,
			redirectUri: REDIRECT_URI,
		});

		const res = await exchangeCode({ code, client_id: CLIENT_ID });
		expect(res.status).toBe(200);
		const body = await res.json<{
			access_token: string;
			token_type: string;
			expires_in: number;
			refresh_token: string;
			scope: string;
		}>();
		expect(body.access_token).toBeDefined();
		expect(body.refresh_token).toBeDefined();
		expect(body.token_type).toBe("Bearer");
		expect(body.expires_in).toBe(3600);
		expect(body.scope).toBe("read-write");
	});

	it("exchanges valid code with PKCE", async () => {
		const { verifier, challenge } = await generatePkce();
		const code = crypto.randomUUID();
		await insertAuthCode({
			code,
			clientId: CLIENT_ID,
			userId: USER_ID,
			redirectUri: REDIRECT_URI,
			codeChallenge: challenge,
			codeChallengeMethod: "S256",
		});

		const res = await exchangeCode({
			code,
			client_id: CLIENT_ID,
			code_verifier: verifier,
		});
		expect(res.status).toBe(200);
		const body = await res.json<{ access_token: string }>();
		expect(body.access_token).toBeDefined();
	});

	it("rejects wrong PKCE verifier", async () => {
		const { challenge } = await generatePkce();
		const code = crypto.randomUUID();
		await insertAuthCode({
			code,
			clientId: CLIENT_ID,
			userId: USER_ID,
			redirectUri: REDIRECT_URI,
			codeChallenge: challenge,
			codeChallengeMethod: "S256",
		});

		const res = await exchangeCode({
			code,
			client_id: CLIENT_ID,
			code_verifier: "wrong-verifier",
		});
		expect(res.status).toBe(400);
		const body = await res.json<{ error: string }>();
		expect(body.error).toBe("invalid_grant");
	});

	it("rejects expired authorization code", async () => {
		const code = crypto.randomUUID();
		const expired = new Date(Date.now() - 1000).toISOString();
		await insertAuthCode({
			code,
			clientId: CLIENT_ID,
			userId: USER_ID,
			redirectUri: REDIRECT_URI,
			expiresAt: expired,
		});

		const res = await exchangeCode({ code, client_id: CLIENT_ID });
		expect(res.status).toBe(400);
		const body = await res.json<{ error_description: string }>();
		expect(body.error_description).toContain("expired");
	});

	it("rejects already-used authorization code", async () => {
		const code = crypto.randomUUID();
		await insertAuthCode({
			code,
			clientId: CLIENT_ID,
			userId: USER_ID,
			redirectUri: REDIRECT_URI,
			used: 1,
		});

		const res = await exchangeCode({ code, client_id: CLIENT_ID });
		expect(res.status).toBe(400);
		const body = await res.json<{ error_description: string }>();
		expect(body.error_description).toContain("already used");
	});

	it("rejects mismatched redirect_uri", async () => {
		const code = crypto.randomUUID();
		await insertAuthCode({
			code,
			clientId: CLIENT_ID,
			userId: USER_ID,
			redirectUri: REDIRECT_URI,
		});

		const res = await exchangeCode({
			code,
			client_id: CLIENT_ID,
			redirect_uri: "http://evil.com/callback",
		});
		expect(res.status).toBe(400);
		const body = await res.json<{ error_description: string }>();
		expect(body.error_description).toContain("Redirect URI mismatch");
	});
});

describe("MCP OAuth - Token endpoint (refresh_token grant)", () => {
	const CLIENT_ID = "refresh-test-client";
	const USER_ID = "refresh-test-user";
	const REDIRECT_URI = "http://localhost:3000/callback";

	beforeAll(async () => {
		await createTestClient(CLIENT_ID, [REDIRECT_URI]);
		await createTestUser(USER_ID);
	});

	it("refreshes token successfully", async () => {
		// First, get tokens via code exchange
		const code = crypto.randomUUID();
		await insertAuthCode({
			code,
			clientId: CLIENT_ID,
			userId: USER_ID,
			redirectUri: REDIRECT_URI,
		});
		const tokenRes = await exchangeCode({ code, client_id: CLIENT_ID });
		const tokens = await tokenRes.json<{
			access_token: string;
			refresh_token: string;
		}>();

		// Now refresh
		const refreshRes = await SELF.fetch("http://localhost/mcp/token", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				grant_type: "refresh_token",
				refresh_token: tokens.refresh_token,
			}),
		});
		expect(refreshRes.status).toBe(200);
		const newTokens = await refreshRes.json<{
			access_token: string;
			refresh_token: string;
		}>();
		expect(newTokens.access_token).toBeDefined();
		expect(newTokens.refresh_token).toBeDefined();
		// New tokens should be different
		expect(newTokens.access_token).not.toBe(tokens.access_token);
		expect(newTokens.refresh_token).not.toBe(tokens.refresh_token);
	});

	it("rejects invalid refresh token", async () => {
		const res = await SELF.fetch("http://localhost/mcp/token", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				grant_type: "refresh_token",
				refresh_token: "nonexistent-token",
			}),
		});
		expect(res.status).toBe(400);
		const body = await res.json<{ error: string }>();
		expect(body.error).toBe("invalid_grant");
	});
});

describe("MCP OAuth - Token validation", () => {
	const CLIENT_ID = "validate-test-client";
	const USER_ID = "validate-test-user";
	const REDIRECT_URI = "http://localhost:3000/callback";

	beforeAll(async () => {
		await createTestClient(CLIENT_ID, [REDIRECT_URI]);
		await createTestUser(USER_ID);
	});

	it("validates a valid access token", async () => {
		const code = crypto.randomUUID();
		await insertAuthCode({
			code,
			clientId: CLIENT_ID,
			userId: USER_ID,
			redirectUri: REDIRECT_URI,
		});
		const res = await exchangeCode({ code, client_id: CLIENT_ID });
		const tokens = await res.json<{ access_token: string }>();

		const result = await validateMcpToken(env.DB, tokens.access_token);
		expect(result).not.toBeNull();
		expect(result!.userId).toBe(USER_ID);
		expect(result!.scope).toBe("read-write");
	});

	it("rejects expired access token", async () => {
		// Insert a token that is already expired
		const expiredToken = crypto.randomUUID();
		await env.DB.prepare(
			`INSERT INTO mcp_oauth_tokens (id, client_id, user_id, access_token, refresh_token, scope, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				crypto.randomUUID(),
				CLIENT_ID,
				USER_ID,
				expiredToken,
				crypto.randomUUID(),
				"read-write",
				new Date(Date.now() - 1000).toISOString(),
			)
			.run();

		const result = await validateMcpToken(env.DB, expiredToken);
		expect(result).toBeNull();
	});

	it("rejects revoked access token", async () => {
		const code = crypto.randomUUID();
		await insertAuthCode({
			code,
			clientId: CLIENT_ID,
			userId: USER_ID,
			redirectUri: REDIRECT_URI,
		});
		const res = await exchangeCode({ code, client_id: CLIENT_ID });
		const tokens = await res.json<{
			access_token: string;
		}>();

		// Revoke the token
		await SELF.fetch("http://localhost/mcp/revoke", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: tokens.access_token }),
		});

		const result = await validateMcpToken(env.DB, tokens.access_token);
		expect(result).toBeNull();
	});
});

describe("MCP OAuth - MCP endpoint integration", () => {
	const CLIENT_ID = "mcp-int-client";
	const USER_ID = "mcp-int-user";
	const REDIRECT_URI = "http://localhost:3000/callback";

	beforeAll(async () => {
		await createTestClient(CLIENT_ID, [REDIRECT_URI]);
		await createTestUser(USER_ID);
	});

	it("authenticates MCP request with OAuth token", async () => {
		const code = crypto.randomUUID();
		await insertAuthCode({
			code,
			clientId: CLIENT_ID,
			userId: USER_ID,
			redirectUri: REDIRECT_URI,
		});
		const tokenRes = await exchangeCode({ code, client_id: CLIENT_ID });
		const tokens = await tokenRes.json<{ access_token: string }>();

		const res = await SELF.fetch("http://localhost/mcp", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${tokens.access_token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
			}),
		});
		expect(res.status).toBe(200);
		const body = await res.json<{
			result: { serverInfo: { name: string } };
		}>();
		expect(body.result.serverInfo.name).toBe("hono-caldav");
	});

	it("legacy Bearer token still works", async () => {
		const res = await SELF.fetch("http://localhost/mcp", {
			method: "POST",
			headers: {
				Authorization: MCP_AUTH,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "ping",
			}),
		});
		expect(res.status).toBe(200);
		const body = await res.json<{ result: Record<string, unknown> }>();
		expect(body.result).toEqual({});
	});

	it("rejects unknown Bearer token", async () => {
		const res = await SELF.fetch("http://localhost/mcp", {
			method: "POST",
			headers: {
				Authorization: "Bearer unknown-random-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "ping",
			}),
		});
		expect(res.status).toBe(401);
	});
});

describe("MCP OAuth - well-known metadata", () => {
	it("returns RFC 8414 compliant metadata", async () => {
		const res = await SELF.fetch(
			"http://localhost/.well-known/oauth-authorization-server",
		);
		expect(res.status).toBe(200);
		const body = await res.json<{
			issuer: string;
			authorization_endpoint: string;
			token_endpoint: string;
			revocation_endpoint: string;
			response_types_supported: string[];
			grant_types_supported: string[];
			code_challenge_methods_supported: string[];
			token_endpoint_auth_methods_supported: string[];
		}>();
		expect(body.issuer).toBe("http://localhost");
		expect(body.authorization_endpoint).toContain("/mcp/authorize");
		expect(body.token_endpoint).toContain("/mcp/token");
		expect(body.revocation_endpoint).toContain("/mcp/revoke");
		expect(body.response_types_supported).toContain("code");
		expect(body.grant_types_supported).toContain("authorization_code");
		expect(body.grant_types_supported).toContain("refresh_token");
		expect(body.code_challenge_methods_supported).toContain("S256");
		expect(body.token_endpoint_auth_methods_supported).toContain("none");
	});
});

describe("MCP OAuth - Revocation", () => {
	const CLIENT_ID = "revoke-test-client";
	const USER_ID = "revoke-test-user";
	const REDIRECT_URI = "http://localhost:3000/callback";

	beforeAll(async () => {
		await createTestClient(CLIENT_ID, [REDIRECT_URI]);
		await createTestUser(USER_ID);
	});

	it("revokes access token", async () => {
		const code = crypto.randomUUID();
		await insertAuthCode({
			code,
			clientId: CLIENT_ID,
			userId: USER_ID,
			redirectUri: REDIRECT_URI,
		});
		const tokenRes = await exchangeCode({ code, client_id: CLIENT_ID });
		const tokens = await tokenRes.json<{
			access_token: string;
		}>();

		const revokeRes = await SELF.fetch("http://localhost/mcp/revoke", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: tokens.access_token }),
		});
		expect(revokeRes.status).toBe(200);

		// Token should now be invalid
		const result = await validateMcpToken(env.DB, tokens.access_token);
		expect(result).toBeNull();
	});

	it("revokes refresh token", async () => {
		const code = crypto.randomUUID();
		await insertAuthCode({
			code,
			clientId: CLIENT_ID,
			userId: USER_ID,
			redirectUri: REDIRECT_URI,
		});
		const tokenRes = await exchangeCode({ code, client_id: CLIENT_ID });
		const tokens = await tokenRes.json<{
			access_token: string;
			refresh_token: string;
		}>();

		const revokeRes = await SELF.fetch("http://localhost/mcp/revoke", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: tokens.refresh_token }),
		});
		expect(revokeRes.status).toBe(200);

		// Refresh should now fail
		const refreshRes = await SELF.fetch("http://localhost/mcp/token", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				grant_type: "refresh_token",
				refresh_token: tokens.refresh_token,
			}),
		});
		expect(refreshRes.status).toBe(400);
	});

	it("returns 200 for unknown token (RFC 7009 compliance)", async () => {
		const revokeRes = await SELF.fetch("http://localhost/mcp/revoke", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: "nonexistent-token" }),
		});
		expect(revokeRes.status).toBe(200);
	});
});
