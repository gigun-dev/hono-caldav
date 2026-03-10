import { authenticateWithAppPassword } from "./app-password.js";

export type CaldavUser = {
	id: string;
	username: string;
	displayName: string | null;
};

/**
 * Authenticate CalDAV Basic Auth request.
 *
 * Strategy:
 * 1. If app_passwords table exists and user has App Passwords → use them
 * 2. Fallback to env CALDAV_USERNAME/CALDAV_PASSWORD for backward compat
 *
 * username = user email (for App Password) or CALDAV_USERNAME (legacy)
 * password = App Password or CALDAV_PASSWORD (legacy)
 */
export async function authenticateBasicUser(
	env: CloudflareBindings,
	db: D1Database,
	username: string,
	password: string,
): Promise<CaldavUser | null> {
	// Try App Password authentication first
	try {
		const userId = await authenticateWithAppPassword(db, username, password);
		if (userId) {
			// Fetch user details
			const user = await db
				.prepare('SELECT id, name, email FROM "user" WHERE id = ?')
				.bind(userId)
				.first<{ id: string; name: string; email: string }>();
			if (user) {
				return {
					id: user.id,
					username: user.email,
					displayName: user.name,
				};
			}
		}
	} catch {
		// App password tables may not exist yet, fall through to legacy auth
	}

	// Legacy: env-based single-user auth
	const expectedUser = (env as unknown as Record<string, unknown>)
		.CALDAV_USERNAME;
	const expectedPass = (env as unknown as Record<string, unknown>)
		.CALDAV_PASSWORD;

	if (
		typeof expectedUser !== "string" ||
		typeof expectedPass !== "string" ||
		!expectedUser ||
		!expectedPass
	) {
		return null;
	}

	if (username !== expectedUser || password !== expectedPass) {
		return null;
	}

	return {
		id: "default",
		username,
		displayName: username,
	};
}
