import { betterAuth } from "better-auth";
import { oAuthProxy } from "better-auth/plugins";

export type CaldavUser = {
	id: string;
	username: string;
	displayName: string | null;
};

function resolveCurrentURL(headers: Headers): string | undefined {
	const host =
		headers.get("x-forwarded-host") ?? headers.get("host") ?? undefined;
	if (!host) return undefined;
	const proto = headers.get("x-forwarded-proto") ?? "http";
	return `${proto}://${host}`;
}

export function createAuth(env: CloudflareBindings, headers?: Headers) {
	const currentURL = headers ? resolveCurrentURL(headers) : undefined;

	return betterAuth({
		database: env.DB,
		baseURL: {
			allowedHosts: env.BETTER_AUTH_ALLOWED_HOSTS
				? env.BETTER_AUTH_ALLOWED_HOSTS.split(",")
				: [],
			protocol: "auto",
		},
		secret: env.BETTER_AUTH_SECRET,
		advanced: {
			trustedProxyHeaders: true,
		},
		socialProviders: {
			google: {
				clientId: env.GOOGLE_CLIENT_ID,
				clientSecret: env.GOOGLE_CLIENT_SECRET,
				accessType: "offline",
				prompt: "consent",
				redirectURI: `${env.BETTER_AUTH_PRODUCTION_URL}/api/auth/callback/google`,
			},
		},
		plugins: [
			oAuthProxy({
				productionURL: env.BETTER_AUTH_PRODUCTION_URL,
				currentURL,
			}),
		],
		session: {
			expiresIn: 60 * 60 * 24 * 7, // 7 days
			updateAge: 60 * 60 * 24, // 24 hours
			cookieCache: {
				enabled: true,
				maxAge: 60 * 5, // 5 minutes
			},
		},
	});
}
