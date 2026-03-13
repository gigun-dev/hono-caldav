import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// SHA-256 of "changeme"
const passwordHash =
	"057ba03d6c44104863dc7361fe4578965d1887360f90a0895882e58a6248fc86";

// Seed users
await env.DB.prepare(
	`INSERT OR IGNORE INTO "user" (id, name, email) VALUES (?, ?, ?)`,
).bind("test-user-a", "Admin", "admin").run();
await env.DB.prepare(
	`INSERT OR IGNORE INTO "user" (id, name, email) VALUES (?, ?, ?)`,
).bind("test-user-b", "Admin B", "admin-b").run();

// Seed app passwords
await env.DB.prepare(
	`INSERT OR IGNORE INTO app_passwords (id, user_id, name, password_hash, prefix) VALUES (?, ?, ?, ?, ?)`,
).bind("test-pw-a", "test-user-a", "Dev", passwordHash, "chan").run();
await env.DB.prepare(
	`INSERT OR IGNORE INTO app_passwords (id, user_id, name, password_hash, prefix) VALUES (?, ?, ?, ?, ?)`,
).bind("test-pw-b", "test-user-b", "Dev", passwordHash, "chan").run();
