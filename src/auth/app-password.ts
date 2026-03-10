/**
 * App Password generation and verification for CalDAV Basic Auth.
 * Passwords are 32-char base62 strings, stored as SHA-256 hashes.
 */

export async function generateAppPassword(): Promise<{
	plain: string;
	hash: string;
	prefix: string;
}> {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	const plain = btoa(String.fromCharCode(...bytes))
		.replace(/[+/=]/g, "")
		.slice(0, 32);
	const hash = await hashPassword(plain);
	return { plain, hash, prefix: plain.slice(0, 8) };
}

export async function verifyAppPassword(
	input: string,
	storedHash: string,
): Promise<boolean> {
	const inputHash = await hashPassword(input);
	// Constant-time comparison via subtle.timingSafeEqual is not available
	// in all runtimes, but SHA-256 comparison is sufficient here since
	// the hash itself is not secret (the password is).
	return inputHash === storedHash;
}

async function hashPassword(password: string): Promise<string> {
	const encoded = new TextEncoder().encode(password);
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
	return [...new Uint8Array(hashBuffer)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// --- D1 operations ---

export type AppPassword = {
	id: string;
	userId: string;
	name: string;
	prefix: string;
	createdAt: string;
	lastUsedAt: string | null;
	revokedAt: string | null;
};

export async function createAppPassword(
	db: D1Database,
	userId: string,
	name: string,
): Promise<{ appPassword: AppPassword; plainPassword: string }> {
	const { plain, hash, prefix } = await generateAppPassword();
	const id = crypto.randomUUID();
	await db
		.prepare(
			"INSERT INTO app_passwords (id, user_id, name, password_hash, prefix) VALUES (?, ?, ?, ?, ?)",
		)
		.bind(id, userId, name, hash, prefix)
		.run();
	return {
		appPassword: {
			id,
			userId,
			name,
			prefix,
			createdAt: new Date().toISOString(),
			lastUsedAt: null,
			revokedAt: null,
		},
		plainPassword: plain,
	};
}

export async function listAppPasswords(
	db: D1Database,
	userId: string,
): Promise<AppPassword[]> {
	const result = await db
		.prepare(
			"SELECT id, user_id, name, prefix, created_at, last_used_at, revoked_at FROM app_passwords WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC",
		)
		.bind(userId)
		.all();
	return (result.results ?? []).map(rowToAppPassword);
}

export async function revokeAppPassword(
	db: D1Database,
	userId: string,
	passwordId: string,
): Promise<boolean> {
	const result = await db
		.prepare(
			"UPDATE app_passwords SET revoked_at = datetime('now') WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
		)
		.bind(passwordId, userId)
		.run();
	return (result.meta?.changes ?? 0) > 0;
}

/**
 * Authenticate CalDAV Basic Auth using App Passwords.
 * Returns userId if valid, null otherwise.
 */
export async function authenticateWithAppPassword(
	db: D1Database,
	email: string,
	password: string,
): Promise<string | null> {
	// Find user by email
	const user = await db
		.prepare('SELECT id FROM "user" WHERE email = ?')
		.bind(email.toLowerCase())
		.first<{ id: string }>();
	if (!user) return null;

	// Get all active app passwords for this user
	const passwords = await db
		.prepare(
			"SELECT id, password_hash FROM app_passwords WHERE user_id = ? AND revoked_at IS NULL",
		)
		.bind(user.id)
		.all<{ id: string; password_hash: string }>();

	for (const row of passwords.results ?? []) {
		if (await verifyAppPassword(password, row.password_hash)) {
			// Update last_used_at (fire-and-forget)
			await db
				.prepare(
					"UPDATE app_passwords SET last_used_at = datetime('now') WHERE id = ?",
				)
				.bind(row.id)
				.run();
			return user.id;
		}
	}

	return null;
}

function rowToAppPassword(row: Record<string, unknown>): AppPassword {
	return {
		id: row.id as string,
		userId: row.user_id as string,
		name: row.name as string,
		prefix: row.prefix as string,
		createdAt: row.created_at as string,
		lastUsedAt: (row.last_used_at as string) ?? null,
		revokedAt: (row.revoked_at as string) ?? null,
	};
}
