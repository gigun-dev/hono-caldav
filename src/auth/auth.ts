import { betterAuth } from "better-auth";
import { anonymous } from "better-auth/plugins/anonymous";
import { oAuthProxy } from "better-auth/plugins/oauth-proxy";

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
		emailAndPassword: {
			enabled: true,
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
			anonymous({
				emailDomainName: "demo.caldav.local",
			}),
		],
		session: {
			expiresIn: 60 * 60 * 24 * 7, // 7 days
			updateAge: 60 * 60 * 24, // 24 hours
		},
	});
}
