import type { CaldavUser } from "./auth.js";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function generateRandomBase62(length: number): string {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => BASE62[b % 62]).join("");
}

async function sha256Hex(input: string): Promise<string> {
	const data = new TextEncoder().encode(input);
	const hash = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(hash), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
}

export async function generateAppPassword(
	db: D1Database,
	userId: string,
): Promise<{ id: string; name: string; password: string; prefix: string }> {
	// Auto-increment name: "App Password 1", "App Password 2", ...
	const { count } = await db
		.prepare(
			"SELECT COUNT(*) as count FROM app_passwords WHERE user_id = ?",
		)
		.bind(userId)
		.first<{ count: number }>() ?? { count: 0 };
	const name = `App Password ${count + 1}`;

	const id = crypto.randomUUID();
	const password = generateRandomBase62(32);
	const prefix = password.slice(0, 4);
	const passwordHash = await sha256Hex(password);

	await db
		.prepare(
			"INSERT INTO app_passwords (id, user_id, name, password_hash, prefix) VALUES (?, ?, ?, ?, ?)",
		)
		.bind(id, userId, name, passwordHash, prefix)
		.run();

	return { id, name, password, prefix };
}

export async function verifyAppPassword(
	db: D1Database,
	email: string,
	password: string,
): Promise<CaldavUser | null> {
	// Look up user by email
	const user = await db
		.prepare('SELECT id, name, email FROM "user" WHERE email = ?')
		.bind(email)
		.first<{ id: string; name: string; email: string }>();

	if (!user) {
		return null;
	}

	// Get active app passwords for this user
	const { results: passwords } = await db
		.prepare(
			"SELECT id, password_hash FROM app_passwords WHERE user_id = ? AND revoked_at IS NULL",
		)
		.bind(user.id)
		.run<{ id: string; password_hash: string }>();

	const inputHash = await sha256Hex(password);

	for (const pw of passwords) {
		if (pw.password_hash === inputHash) {
			// Update last_used_at (fire-and-forget)
			db.prepare(
				"UPDATE app_passwords SET last_used_at = datetime('now') WHERE id = ?",
			)
				.bind(pw.id)
				.run();

			return {
				id: user.id,
				username: user.email,
				displayName: user.name,
			};
		}
	}

	return null;
}

export async function listAppPasswords(
	db: D1Database,
	userId: string,
): Promise<
	{
		id: string;
		name: string;
		prefix: string;
		created_at: string;
		last_used_at: string | null;
	}[]
> {
	const { results } = await db
		.prepare(
			"SELECT id, name, prefix, created_at, last_used_at FROM app_passwords WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC",
		)
		.bind(userId)
		.run<{
			id: string;
			name: string;
			prefix: string;
			created_at: string;
			last_used_at: string | null;
		}>();

	return results;
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

	return (result.meta.changes ?? 0) > 0;
}
