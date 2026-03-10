import { betterAuth } from "better-auth";

/**
 * Create a better-auth instance per request.
 * Workers require env bindings at request time, so we cannot use a singleton.
 */
export function createAuth(env: CloudflareBindings) {
	return betterAuth({
		database: env.DB,
		baseURL: env.BETTER_AUTH_URL,
		basePath: "/api/auth",
		secret: env.BETTER_AUTH_SECRET,
		trustedOrigins: [env.BETTER_AUTH_URL],
		socialProviders: {
			google: {
				clientId: env.GOOGLE_CLIENT_ID,
				clientSecret: env.GOOGLE_CLIENT_SECRET,
				accessType: "offline",
				prompt: "consent",
				scope: [
					"openid",
					"email",
					"profile",
					"https://www.googleapis.com/auth/gmail.readonly",
					"https://www.googleapis.com/auth/calendar.readonly",
					"https://www.googleapis.com/auth/calendar.events",
				],
			},
		},
		account: {
			encryptOAuthTokens: true,
		},
		session: {
			expiresIn: 60 * 60 * 24 * 7, // 7 days
			updateAge: 60 * 60 * 24, // refresh every 24h
			cookieCache: {
				enabled: true,
				maxAge: 60 * 5, // 5 min cache
				strategy: "compact",
			},
		},
	});
}
