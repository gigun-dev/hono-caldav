export type CaldavUser = {
	id: string;
	username: string;
	displayName: string | null;
};

/**
 * Workers Secrets (CALDAV_USERNAME / CALDAV_PASSWORD) で固定ユーザー認証。
 * env に Secrets が設定されていない場合は認証失敗とする。
 */
export function authenticateBasicUser(
	env: CloudflareBindings,
	username: string,
	password: string,
): CaldavUser | null {
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
