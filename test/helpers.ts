import { env, SELF } from "cloudflare:test";

// --- Auth constants ---

/** User A: admin:changeme */
export const AUTH_A = "Basic " + btoa("admin:changeme");
/** User B: admin-b:changeme */
export const AUTH_B = "Basic " + btoa("admin-b:changeme");
/** Invalid credentials */
export const AUTH_BAD = "Basic " + btoa("admin:wrong-password");

// --- Request helper ---

/**
 * Send an authenticated request via SELF.fetch.
 * @param auth - defaults to AUTH_A (User A)
 */
export function request(
	method: string,
	path: string,
	authOrOpts?:
		| string
		| { body?: string; headers?: Record<string, string> },
	opts?: { body?: string; headers?: Record<string, string> },
) {
	let auth: string;
	let options: { body?: string; headers?: Record<string, string> };

	if (typeof authOrOpts === "string") {
		auth = authOrOpts;
		options = opts ?? {};
	} else {
		auth = AUTH_A;
		options = authOrOpts ?? {};
	}

	return SELF.fetch(`http://localhost${path}`, {
		method,
		headers: {
			Authorization: auth,
			...options.headers,
		},
		body: options.body,
		redirect: "manual",
	});
}

// --- ICS builders ---

export function makeVtodo(uid: string, summary: string): string {
	return [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Test//Test//EN",
		"BEGIN:VTODO",
		`UID:${uid}`,
		`DTSTAMP:20250101T000000Z`,
		`SUMMARY:${summary}`,
		"STATUS:NEEDS-ACTION",
		"END:VTODO",
		"END:VCALENDAR",
	].join("\r\n");
}

export function makeVevent(uid: string, summary: string): string {
	return [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Test//Test//EN",
		"BEGIN:VEVENT",
		`UID:${uid}`,
		`DTSTAMP:20250101T000000Z`,
		`DTSTART:20250115T090000Z`,
		`DTEND:20250115T100000Z`,
		`SUMMARY:${summary}`,
		"END:VEVENT",
		"END:VCALENDAR",
	].join("\r\n");
}

// --- DB seed helpers ---

/**
 * Insert a test calendar and return its id.
 * @param userId - defaults to "test-user-a"
 */
export async function seedCalendar(
	name: string,
	componentType: string,
	userId = "test-user-a",
): Promise<number> {
	await env.DB.prepare(
		"INSERT INTO calendars (user_id, name, component_type) VALUES (?, ?, ?)",
	)
		.bind(userId, name, componentType)
		.run();
	const row = await env.DB.prepare(
		"SELECT id FROM calendars WHERE user_id = ? ORDER BY id DESC LIMIT 1",
	)
		.bind(userId)
		.first<{ id: number }>();
	return row!.id;
}
