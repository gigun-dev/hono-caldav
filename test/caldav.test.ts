import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import "../src/index.js";

// --- Helpers ---

const AUTH = "Basic " + btoa("test-user:test-pass");
const AUTH_BAD = "Basic " + btoa("test-user:wrong");

function request(
	method: string,
	path: string,
	opts: { body?: string; headers?: Record<string, string> } = {},
) {
	return SELF.fetch(`http://localhost${path}`, {
		method,
		headers: {
			Authorization: AUTH,
			...opts.headers,
		},
		body: opts.body,
		redirect: "manual",
	});
}

function makeVtodo(uid: string, summary: string): string {
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

function makeVevent(uid: string, summary: string): string {
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

/** Insert a test calendar and return its id */
async function seedCalendar(
	name: string,
	componentType: string,
): Promise<number> {
	await env.DB.prepare(
		"INSERT INTO calendars (user_id, name, component_type) VALUES (?, ?, ?)",
	)
		.bind("default", name, componentType)
		.run();
	const row = await env.DB.prepare(
		"SELECT id FROM calendars WHERE user_id = ? ORDER BY id DESC LIMIT 1",
	)
		.bind("default")
		.first<{ id: number }>();
	return row!.id;
}

// === 1. Authentication ===

describe("Authentication", () => {
	beforeAll(async () => {
		await seedCalendar("Test Calendar", "VTODO");
	});

	it("returns 401 without credentials", async () => {
		const res = await SELF.fetch("http://localhost/dav/", {
			method: "PROPFIND",
		});
		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toContain("Basic");
	});

	it("returns 401 with wrong password", async () => {
		const res = await SELF.fetch("http://localhost/dav/", {
			method: "PROPFIND",
			headers: { Authorization: AUTH_BAD },
		});
		expect(res.status).toBe(401);
	});

	it("returns 207 with valid credentials", async () => {
		const res = await request("PROPFIND", "/dav/");
		expect(res.status).toBe(207);
	});
});

// === 2. PROPFIND ===

describe("PROPFIND", () => {
	let calendarId: number;
	beforeAll(async () => {
		calendarId = await seedCalendar("Test Calendar", "VTODO");
	});

	it("PROPFIND / returns multistatus with current-user-principal", async () => {
		const res = await request("PROPFIND", "/");
		expect(res.status).toBe(207);
		const xml = await res.text();
		expect(xml).toContain("current-user-principal");
		expect(xml).toContain("/dav/principals/test-user/");
	});

	it("OPTIONS / returns 204 with DAV headers", async () => {
		const res = await request("OPTIONS", "/");
		expect(res.status).toBe(204);
		expect(res.headers.get("DAV")).toContain("calendar-access");
		expect(res.headers.get("Allow")).toContain("PROPFIND");
	});

	it("PROPFIND /dav/ returns multistatus with current-user-principal", async () => {
		const res = await request("PROPFIND", "/dav/");
		expect(res.status).toBe(207);
		const xml = await res.text();
		expect(xml).toContain("current-user-principal");
		expect(xml).toContain("/dav/principals/test-user/");
	});

	it("PROPFIND /dav/principals/test-user returns calendar-home-set", async () => {
		const res = await request("PROPFIND", "/dav/principals/test-user");
		expect(res.status).toBe(207);
		const xml = await res.text();
		expect(xml).toContain("calendar-home-set");
		expect(xml).toContain("/dav/projects/");
	});

	it("PROPFIND /dav/projects/ depth 0 returns collection", async () => {
		const res = await request("PROPFIND", "/dav/projects/", {
			headers: { Depth: "0" },
		});
		expect(res.status).toBe(207);
		const xml = await res.text();
		expect(xml).toContain("<d:collection/>");
	});

	it("PROPFIND /dav/projects/ depth 1 lists calendars", async () => {
		const res = await request("PROPFIND", "/dav/projects/", {
			headers: { Depth: "1" },
		});
		expect(res.status).toBe(207);
		const xml = await res.text();
		expect(xml).toContain("Test Calendar");
		expect(xml).toContain(`/dav/projects/${calendarId}/`);
	});

	it("PROPFIND /dav/projects/:id depth 0 returns calendar props", async () => {
		const res = await request("PROPFIND", `/dav/projects/${calendarId}/`, {
			headers: { Depth: "0" },
		});
		expect(res.status).toBe(207);
		const xml = await res.text();
		expect(xml).toContain("Test Calendar");
		expect(xml).toContain("<c:calendar/>");
	});

	it("PROPFIND /dav/projects/:id returns sync-token when requested", async () => {
		const body = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:sync-token/>
    <cs:getctag xmlns:cs="http://calendarserver.org/ns/"/>
  </d:prop>
</d:propfind>`;

		const res = await request("PROPFIND", `/dav/projects/${calendarId}/`, {
			body,
			headers: { Depth: "0" },
		});
		expect(res.status).toBe(207);
		const xml = await res.text();
		expect(xml).toContain("<d:sync-token>");
		expect(xml).toContain("getctag");
	});

	it("PROPFIND /dav/projects/ depth 1 returns sync-token for each calendar", async () => {
		const body = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/>
    <d:sync-token/>
  </d:prop>
</d:propfind>`;

		const res = await request("PROPFIND", "/dav/projects/", {
			body,
			headers: { Depth: "1" },
		});
		expect(res.status).toBe(207);
		const xml = await res.text();
		expect(xml).toContain("<d:sync-token>");
	});
});

// === 3. PUT (create/update VTODO) ===

describe("PUT", () => {
	let calendarId: number;
	beforeAll(async () => {
		calendarId = await seedCalendar("Test Calendar", "VTODO");
	});

	it("creates a new VTODO and returns 201", async () => {
		const ics = makeVtodo("test-put-1", "Buy milk");
		const res = await request(
			"PUT",
			`/dav/projects/${calendarId}/test-put-1.ics`,
			{
				body: ics,
				headers: { "Content-Type": "text/calendar" },
			},
		);
		expect(res.status).toBe(201);
		expect(res.headers.get("ETag")).toBeTruthy();
	});

	it("updates an existing VTODO and returns 200", async () => {
		// Create first, then update in the same test
		const ics1 = makeVtodo("test-put-2", "Original");
		const res1 = await request(
			"PUT",
			`/dav/projects/${calendarId}/test-put-2.ics`,
			{
				body: ics1,
				headers: { "Content-Type": "text/calendar" },
			},
		);
		expect(res1.status).toBe(201);

		const ics2 = makeVtodo("test-put-2", "Updated");
		const res2 = await request(
			"PUT",
			`/dav/projects/${calendarId}/test-put-2.ics`,
			{
				body: ics2,
				headers: { "Content-Type": "text/calendar" },
			},
		);
		expect(res2.status).toBe(204);
	});

	it("rejects invalid ICS data with 400", async () => {
		const res = await request("PUT", `/dav/projects/${calendarId}/bad.ics`, {
			body: "not valid ics data",
			headers: { "Content-Type": "text/calendar" },
		});
		expect(res.status).toBe(400);
	});
});

// === 4. GET ===

describe("GET", () => {
	let calendarId: number;
	beforeAll(async () => {
		calendarId = await seedCalendar("Test Calendar", "VTODO");
	});

	it("returns ICS data for an existing VTODO", async () => {
		const ics = makeVtodo("test-get-1", "Get task");
		await request("PUT", `/dav/projects/${calendarId}/test-get-1.ics`, {
			body: ics,
			headers: { "Content-Type": "text/calendar" },
		});

		const res = await request(
			"GET",
			`/dav/projects/${calendarId}/test-get-1.ics`,
		);
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain("VTODO");
		expect(text).toContain("Get task");
		expect(res.headers.get("Content-Type")).toContain("text/calendar");
		expect(res.headers.get("ETag")).toBeTruthy();
	});

	it("returns 404 for non-existent VTODO", async () => {
		const res = await request(
			"GET",
			`/dav/projects/${calendarId}/nonexistent.ics`,
		);
		expect(res.status).toBe(404);
	});
});

// === 5. DELETE ===

describe("DELETE", () => {
	let calendarId: number;
	beforeAll(async () => {
		calendarId = await seedCalendar("Test Calendar", "VTODO");
	});

	it("deletes an existing VTODO and returns 204, then GET returns 404", async () => {
		const ics = makeVtodo("test-del-1", "Delete me");
		await request("PUT", `/dav/projects/${calendarId}/test-del-1.ics`, {
			body: ics,
			headers: { "Content-Type": "text/calendar" },
		});

		const res = await request(
			"DELETE",
			`/dav/projects/${calendarId}/test-del-1.ics`,
		);
		expect(res.status).toBe(204);

		// Verify it's gone
		const getRes = await request(
			"GET",
			`/dav/projects/${calendarId}/test-del-1.ics`,
		);
		expect(getRes.status).toBe(404);
	});

	it("returns 404 when deleting non-existent VTODO", async () => {
		const res = await request(
			"DELETE",
			`/dav/projects/${calendarId}/nonexistent.ics`,
		);
		expect(res.status).toBe(404);
	});
});

// === 6. REPORT sync-collection ===

describe("REPORT sync-collection", () => {
	let calendarId: number;
	beforeAll(async () => {
		calendarId = await seedCalendar("Test Calendar", "VTODO");
	});

	it("initial sync returns all objects with sync-token", async () => {
		const ics = makeVtodo("test-sync-1", "Sync item");
		await request("PUT", `/dav/projects/${calendarId}/test-sync-1.ics`, {
			body: ics,
			headers: { "Content-Type": "text/calendar" },
		});

		const body = `<?xml version="1.0" encoding="UTF-8"?>
<d:sync-collection xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:sync-token></d:sync-token>
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
</d:sync-collection>`;

		const res = await request("REPORT", `/dav/projects/${calendarId}/`, {
			body,
		});
		expect(res.status).toBe(207);
		const xml = await res.text();
		expect(xml).toContain("sync-token");
		expect(xml).toContain("test-sync-1");
	});

	it("incremental sync detects additions", async () => {
		// Create initial object to get a sync token
		const ics1 = makeVtodo("sync-add-base", "Base");
		await request("PUT", `/dav/projects/${calendarId}/sync-add-base.ics`, {
			body: ics1,
			headers: { "Content-Type": "text/calendar" },
		});

		// Get current sync token
		const syncBody1 = `<?xml version="1.0" encoding="UTF-8"?>
<d:sync-collection xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:sync-token></d:sync-token>
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
</d:sync-collection>`;
		const res1 = await request("REPORT", `/dav/projects/${calendarId}/`, {
			body: syncBody1,
		});
		const xml1 = await res1.text();
		const tokenMatch = xml1.match(/<d:sync-token>(\d+)<\/d:sync-token>/);
		expect(tokenMatch).toBeTruthy();
		const token = tokenMatch![1];

		// Add a new object
		const ics2 = makeVtodo("sync-add-new", "New sync item");
		await request("PUT", `/dav/projects/${calendarId}/sync-add-new.ics`, {
			body: ics2,
			headers: { "Content-Type": "text/calendar" },
		});

		// Incremental sync
		const syncBody2 = `<?xml version="1.0" encoding="UTF-8"?>
<d:sync-collection xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:sync-token>${token}</d:sync-token>
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
</d:sync-collection>`;
		const res2 = await request("REPORT", `/dav/projects/${calendarId}/`, {
			body: syncBody2,
		});
		expect(res2.status).toBe(207);
		const xml2 = await res2.text();
		expect(xml2).toContain("sync-add-new");
		// Should NOT contain the base object
		expect(xml2).not.toContain("sync-add-base");
	});

	it("incremental sync detects deletions", async () => {
		// Create an object
		const ics = makeVtodo("sync-del-target", "Will delete");
		await request("PUT", `/dav/projects/${calendarId}/sync-del-target.ics`, {
			body: ics,
			headers: { "Content-Type": "text/calendar" },
		});

		// Get current sync token
		const syncBody1 = `<?xml version="1.0" encoding="UTF-8"?>
<d:sync-collection xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:sync-token></d:sync-token>
  <d:prop><d:getetag/></d:prop>
</d:sync-collection>`;
		const res1 = await request("REPORT", `/dav/projects/${calendarId}/`, {
			body: syncBody1,
		});
		const xml1 = await res1.text();
		const tokenMatch = xml1.match(/<d:sync-token>(\d+)<\/d:sync-token>/);
		const token = tokenMatch![1];

		// Delete the object
		await request("DELETE", `/dav/projects/${calendarId}/sync-del-target.ics`);

		// Incremental sync — should see 410 Gone
		const syncBody2 = `<?xml version="1.0" encoding="UTF-8"?>
<d:sync-collection xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:sync-token>${token}</d:sync-token>
  <d:prop><d:getetag/></d:prop>
</d:sync-collection>`;
		const res2 = await request("REPORT", `/dav/projects/${calendarId}/`, {
			body: syncBody2,
		});
		expect(res2.status).toBe(207);
		const xml2 = await res2.text();
		expect(xml2).toContain("410 Gone");
	});
});

// === 6b. Sync-collection: full lifecycle (add, update, delete) ===

describe("REPORT sync-collection lifecycle", () => {
	let calendarId: number;
	beforeAll(async () => {
		calendarId = await seedCalendar("Sync Lifecycle", "VTODO");
	});

	it("tracks add, update, and delete operations correctly", async () => {
		// Get initial sync token
		const syncBody = (token: string) => `<?xml version="1.0" encoding="UTF-8"?>
<d:sync-collection xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:sync-token>${token}</d:sync-token>
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
</d:sync-collection>`;

		const res0 = await request("REPORT", `/dav/projects/${calendarId}/`, {
			body: syncBody(""),
		});
		const xml0 = await res0.text();
		const token0 = xml0.match(/<d:sync-token>(\d+)<\/d:sync-token>/)![1];

		// 1. Create an object
		const ics1 = makeVtodo("sync-lifecycle-1", "Created");
		await request("PUT", `/dav/projects/${calendarId}/sync-lifecycle-1.ics`, {
			body: ics1,
			headers: { "Content-Type": "text/calendar" },
		});

		// Sync after create — should see the addition
		const res1 = await request("REPORT", `/dav/projects/${calendarId}/`, {
			body: syncBody(token0),
		});
		expect(res1.status).toBe(207);
		const xml1 = await res1.text();
		expect(xml1).toContain("sync-lifecycle-1");
		expect(xml1).toContain("200 OK");
		const token1 = xml1.match(/<d:sync-token>(\d+)<\/d:sync-token>/)![1];
		expect(Number(token1)).toBeGreaterThan(Number(token0));

		// 2. Update the object
		const ics2 = makeVtodo("sync-lifecycle-1", "Updated");
		await request("PUT", `/dav/projects/${calendarId}/sync-lifecycle-1.ics`, {
			body: ics2,
			headers: { "Content-Type": "text/calendar" },
		});

		// Sync after update — should see the modification
		const res2 = await request("REPORT", `/dav/projects/${calendarId}/`, {
			body: syncBody(token1),
		});
		expect(res2.status).toBe(207);
		const xml2 = await res2.text();
		expect(xml2).toContain("sync-lifecycle-1");
		expect(xml2).toContain("Updated");
		const token2 = xml2.match(/<d:sync-token>(\d+)<\/d:sync-token>/)![1];
		expect(Number(token2)).toBeGreaterThan(Number(token1));

		// 3. Delete the object
		await request("DELETE", `/dav/projects/${calendarId}/sync-lifecycle-1.ics`);

		// Sync after delete — should see 410 Gone
		const res3 = await request("REPORT", `/dav/projects/${calendarId}/`, {
			body: syncBody(token2),
		});
		expect(res3.status).toBe(207);
		const xml3 = await res3.text();
		expect(xml3).toContain("sync-lifecycle-1");
		expect(xml3).toContain("410 Gone");
		const token3 = xml3.match(/<d:sync-token>(\d+)<\/d:sync-token>/)![1];
		expect(Number(token3)).toBeGreaterThan(Number(token2));
	});
});

// === 7. REPORT calendar-multiget ===

describe("REPORT calendar-multiget", () => {
	let calendarId: number;
	beforeAll(async () => {
		calendarId = await seedCalendar("Test Calendar", "VTODO");
	});

	it("returns requested objects by href", async () => {
		const ics1 = makeVtodo("test-mg-1", "Multiget 1");
		const ics2 = makeVtodo("test-mg-2", "Multiget 2");
		await request("PUT", `/dav/projects/${calendarId}/test-mg-1.ics`, {
			body: ics1,
			headers: { "Content-Type": "text/calendar" },
		});
		await request("PUT", `/dav/projects/${calendarId}/test-mg-2.ics`, {
			body: ics2,
			headers: { "Content-Type": "text/calendar" },
		});

		const body = `<?xml version="1.0" encoding="UTF-8"?>
<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <d:href>/dav/projects/${calendarId}/test-mg-1.ics</d:href>
  <d:href>/dav/projects/${calendarId}/test-mg-2.ics</d:href>
</c:calendar-multiget>`;

		const res = await request("REPORT", `/dav/projects/${calendarId}/`, {
			body,
		});
		expect(res.status).toBe(207);
		const xml = await res.text();
		expect(xml).toContain("Multiget 1");
		expect(xml).toContain("Multiget 2");
	});

	it("returns 404 for non-existent href in multiget", async () => {
		const body = `<?xml version="1.0" encoding="UTF-8"?>
<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <d:href>/dav/projects/${calendarId}/does-not-exist.ics</d:href>
</c:calendar-multiget>`;

		const res = await request("REPORT", `/dav/projects/${calendarId}/`, {
			body,
		});
		expect(res.status).toBe(207);
		const xml = await res.text();
		expect(xml).toContain("404 Not Found");
	});
});

// === 8. PROPPATCH ===

describe("PROPPATCH", () => {
	let calendarId: number;
	beforeAll(async () => {
		calendarId = await seedCalendar("Test Calendar", "VTODO");
	});

	it("updates calendar display name and PROPFIND reflects it", async () => {
		const body = `<?xml version="1.0" encoding="UTF-8"?>
<d:propertyupdate xmlns:d="DAV:">
  <d:set>
    <d:prop>
      <d:displayname>Renamed Calendar</d:displayname>
    </d:prop>
  </d:set>
</d:propertyupdate>`;

		const res = await request("PROPPATCH", `/dav/projects/${calendarId}/`, {
			body,
		});
		expect(res.status).toBe(207);
		const xml = await res.text();
		expect(xml).toContain("Renamed Calendar");

		// Verify PROPFIND reflects the change
		const propfindRes = await request(
			"PROPFIND",
			`/dav/projects/${calendarId}/`,
			{ headers: { Depth: "0" } },
		);
		const propfindXml = await propfindRes.text();
		expect(propfindXml).toContain("Renamed Calendar");
	});
});

// === 9. Extended MKCOL (RFC 5689) ===

describe("Extended MKCOL", () => {
	it("creates a VTODO calendar and returns 201 with Location", async () => {
		const body = `<?xml version="1.0" encoding="UTF-8"?>
<d:mkcol xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:set>
    <d:prop>
      <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
      <d:displayname>My Tasks</d:displayname>
      <c:supported-calendar-component-set>
        <c:comp name="VTODO"/>
      </c:supported-calendar-component-set>
    </d:prop>
  </d:set>
</d:mkcol>`;

		const res = await request("MKCOL", "/dav/projects/my-tasks", { body });
		expect(res.status).toBe(201);
		const location = res.headers.get("Location");
		expect(location).toBeTruthy();
		expect(location).toMatch(/^\/dav\/projects\/\d+\/$/);
	});

	it("creates a VEVENT calendar and returns 201 with Location", async () => {
		const body = `<?xml version="1.0" encoding="UTF-8"?>
<d:mkcol xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:set>
    <d:prop>
      <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
      <d:displayname>My Events</d:displayname>
      <c:supported-calendar-component-set>
        <c:comp name="VEVENT"/>
      </c:supported-calendar-component-set>
    </d:prop>
  </d:set>
</d:mkcol>`;

		const res = await request("MKCOL", "/dav/projects/my-events", { body });
		expect(res.status).toBe(201);
		const location = res.headers.get("Location");
		expect(location).toBeTruthy();
		expect(location).toMatch(/^\/dav\/projects\/\d+\/$/);
	});

	it("defaults to VEVENT when no comp specified", async () => {
		const body = `<?xml version="1.0" encoding="UTF-8"?>
<d:mkcol xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:set>
    <d:prop>
      <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
      <d:displayname>Default Calendar</d:displayname>
    </d:prop>
  </d:set>
</d:mkcol>`;

		const res = await request("MKCOL", "/dav/projects/default-cal", { body });
		expect(res.status).toBe(201);
	});

	it("returns 401 without credentials", async () => {
		const body = `<?xml version="1.0" encoding="UTF-8"?>
<d:mkcol xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:set>
    <d:prop>
      <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
      <d:displayname>Unauthorized</d:displayname>
    </d:prop>
  </d:set>
</d:mkcol>`;

		const res = await SELF.fetch("http://localhost/dav/projects/test", {
			method: "MKCOL",
			body,
		});
		expect(res.status).toBe(401);
	});

	it("MKCOL saves calendar-color and calendar-order", async () => {
		const body = `<?xml version="1.0" encoding="UTF-8"?>
<d:mkcol xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:ical="http://apple.com/ns/ical/">
  <d:set>
    <d:prop>
      <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
      <d:displayname>Colored Tasks</d:displayname>
      <c:supported-calendar-component-set>
        <c:comp name="VTODO"/>
      </c:supported-calendar-component-set>
      <ical:calendar-color>#FF0000</ical:calendar-color>
      <ical:calendar-order>3</ical:calendar-order>
    </d:prop>
  </d:set>
</d:mkcol>`;

		const res = await request("MKCOL", "/dav/projects/colored-tasks", {
			body,
		});
		expect(res.status).toBe(201);
		const location = res.headers.get("Location")!;
		expect(location).toBeTruthy();

		// PROPFIND the created calendar to verify color and order
		const propRes = await request("PROPFIND", location, {
			headers: { Depth: "0" },
		});
		expect(propRes.status).toBe(207);
		const xml = await propRes.text();
		expect(xml).toContain("#FF0000");
		expect(xml).toContain("<ical:calendar-order>3</ical:calendar-order>");
	});

	it("returns 400 for invalid component type", async () => {
		const body = `<?xml version="1.0" encoding="UTF-8"?>
<d:mkcol xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:set>
    <d:prop>
      <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
      <d:displayname>Bad</d:displayname>
      <c:supported-calendar-component-set>
        <c:comp name="VJOURNAL"/>
      </c:supported-calendar-component-set>
    </d:prop>
  </d:set>
</d:mkcol>`;

		const res = await request("MKCOL", "/dav/projects/bad", { body });
		expect(res.status).toBe(400);
	});
});

// === 9b. MKCALENDAR (RFC 4791 §5.3.1, via POST + X-Caldav-Method proxy) ===

describe("MKCALENDAR (proxy)", () => {
	it("creates a VTODO calendar via POST + X-Caldav-Method header", async () => {
		const body = `<?xml version="1.0" encoding="UTF-8"?>
<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:set>
    <d:prop>
      <d:displayname>MKCALENDAR Tasks</d:displayname>
      <c:supported-calendar-component-set>
        <c:comp name="VTODO"/>
      </c:supported-calendar-component-set>
    </d:prop>
  </d:set>
</c:mkcalendar>`;

		const res = await SELF.fetch("http://localhost/dav/projects/mkcal-tasks", {
			method: "POST",
			headers: {
				Authorization: AUTH,
				"X-Caldav-Method": "MKCALENDAR",
			},
			body,
		});
		expect(res.status).toBe(201);
		const location = res.headers.get("Location");
		expect(location).toBeTruthy();
		expect(location).toMatch(/\/dav\/projects\/\d+\//);
	});

	it("creates a VEVENT calendar via MKCALENDAR proxy", async () => {
		const body = `<?xml version="1.0" encoding="UTF-8"?>
<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:set>
    <d:prop>
      <d:displayname>MKCALENDAR Events</d:displayname>
      <c:supported-calendar-component-set>
        <c:comp name="VEVENT"/>
      </c:supported-calendar-component-set>
    </d:prop>
  </d:set>
</c:mkcalendar>`;

		const res = await SELF.fetch("http://localhost/dav/projects/mkcal-events", {
			method: "POST",
			headers: {
				Authorization: AUTH,
				"X-Caldav-Method": "MKCALENDAR",
			},
			body,
		});
		expect(res.status).toBe(201);
		const location = res.headers.get("Location");
		expect(location).toBeTruthy();
	});

	it("returns 405 when POST has no X-Caldav-Method header", async () => {
		const body = `<?xml version="1.0" encoding="UTF-8"?>
<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:set><d:prop><d:displayname>Nope</d:displayname></d:prop></d:set>
</c:mkcalendar>`;

		const res = await SELF.fetch("http://localhost/dav/projects/bad-post", {
			method: "POST",
			headers: { Authorization: AUTH },
			body,
		});
		expect(res.status).toBe(405);
	});

	it("returns 401 without credentials", async () => {
		const body = `<?xml version="1.0" encoding="UTF-8"?>
<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:set><d:prop><d:displayname>Unauth</d:displayname></d:prop></d:set>
</c:mkcalendar>`;

		const res = await SELF.fetch("http://localhost/dav/projects/unauth", {
			method: "POST",
			headers: { "X-Caldav-Method": "MKCALENDAR" },
			body,
		});
		expect(res.status).toBe(401);
	});

	it("MKCALENDAR defaults to VTODO when no comp specified", async () => {
		const body = `<?xml version="1.0" encoding="UTF-8"?>
<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:set>
    <d:prop>
      <d:displayname>Default Comp</d:displayname>
    </d:prop>
  </d:set>
</c:mkcalendar>`;

		const res = await SELF.fetch("http://localhost/dav/projects/default-comp", {
			method: "POST",
			headers: {
				Authorization: AUTH,
				"X-Caldav-Method": "MKCALENDAR",
			},
			body,
		});
		expect(res.status).toBe(201);
	});
});

// === 10. VEVENT PUT/GET ===

describe("VEVENT PUT/GET", () => {
	let calendarId: number;
	beforeAll(async () => {
		calendarId = await seedCalendar("Event Calendar", "VEVENT");
	});

	it("creates a VEVENT and returns 201", async () => {
		const ics = makeVevent("event-1", "Team Meeting");
		const res = await request(
			"PUT",
			`/dav/projects/${calendarId}/event-1.ics`,
			{
				body: ics,
				headers: { "Content-Type": "text/calendar" },
			},
		);
		expect(res.status).toBe(201);
		expect(res.headers.get("ETag")).toBeTruthy();
	});

	it("GET returns VEVENT data", async () => {
		const ics = makeVevent("event-get-1", "Standup");
		await request("PUT", `/dav/projects/${calendarId}/event-get-1.ics`, {
			body: ics,
			headers: { "Content-Type": "text/calendar" },
		});

		const res = await request(
			"GET",
			`/dav/projects/${calendarId}/event-get-1.ics`,
		);
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain("VEVENT");
		expect(text).toContain("Standup");
	});
});

// === 11. Cross-validation ===

describe("Cross-validation", () => {
	let vtodoCalId: number;
	let veventCalId: number;
	beforeAll(async () => {
		vtodoCalId = await seedCalendar("Tasks", "VTODO");
		veventCalId = await seedCalendar("Events", "VEVENT");
	});

	it("rejects VEVENT on VTODO calendar with 400", async () => {
		const ics = makeVevent("cross-1", "Wrong type");
		const res = await request(
			"PUT",
			`/dav/projects/${vtodoCalId}/cross-1.ics`,
			{
				body: ics,
				headers: { "Content-Type": "text/calendar" },
			},
		);
		expect(res.status).toBe(400);
	});

	it("rejects VTODO on VEVENT calendar with 400", async () => {
		const ics = makeVtodo("cross-2", "Wrong type");
		const res = await request(
			"PUT",
			`/dav/projects/${veventCalId}/cross-2.ics`,
			{
				body: ics,
				headers: { "Content-Type": "text/calendar" },
			},
		);
		expect(res.status).toBe(400);
	});
});

// === 12. PROPFIND supported-calendar-component-set ===

describe("PROPFIND supported-calendar-component-set", () => {
	it("VTODO calendar reports VTODO component", async () => {
		const calId = await seedCalendar("VTODO Cal", "VTODO");
		const res = await request("PROPFIND", `/dav/projects/${calId}/`, {
			headers: { Depth: "0" },
		});
		expect(res.status).toBe(207);
		const xml = await res.text();
		expect(xml).toContain('<c:comp name="VTODO"/>');
		expect(xml).not.toContain('<c:comp name="VEVENT"/>');
	});

	it("VEVENT calendar reports VEVENT component", async () => {
		const calId = await seedCalendar("VEVENT Cal", "VEVENT");
		const res = await request("PROPFIND", `/dav/projects/${calId}/`, {
			headers: { Depth: "0" },
		});
		expect(res.status).toBe(207);
		const xml = await res.text();
		expect(xml).toContain('<c:comp name="VEVENT"/>');
		expect(xml).not.toContain('<c:comp name="VTODO"/>');
	});
});

// === 13. ETag SHA-256 ===

describe("ETag SHA-256", () => {
	let calendarId: number;
	beforeAll(async () => {
		calendarId = await seedCalendar("ETag Test", "VTODO");
	});

	it("PUT returns ETag as 64-char hex wrapped in quotes", async () => {
		const ics = makeVtodo("etag-sha-1", "SHA ETag test");
		const res = await request(
			"PUT",
			`/dav/projects/${calendarId}/etag-sha-1.ics`,
			{
				body: ics,
				headers: { "Content-Type": "text/calendar" },
			},
		);
		expect(res.status).toBe(201);
		const etag = res.headers.get("ETag");
		expect(etag).toBeTruthy();
		// SHA-256 hex = 64 chars, wrapped in quotes = 66 chars
		expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
	});

	it("GET returns same SHA-256 ETag as PUT", async () => {
		const ics = makeVtodo("etag-sha-2", "SHA ETag consistency");
		const putRes = await request(
			"PUT",
			`/dav/projects/${calendarId}/etag-sha-2.ics`,
			{
				body: ics,
				headers: { "Content-Type": "text/calendar" },
			},
		);
		const putEtag = putRes.headers.get("ETag");

		const getRes = await request(
			"GET",
			`/dav/projects/${calendarId}/etag-sha-2.ics`,
		);
		const getEtag = getRes.headers.get("ETag");
		expect(getEtag).toBe(putEtag);
	});

	it("GET with matching If-None-Match returns 304", async () => {
		const ics = makeVtodo("etag-304-test", "304 Test");
		const putRes = await request(
			"PUT",
			`/dav/projects/${calendarId}/etag-304-test.ics`,
			{
				body: ics,
				headers: { "Content-Type": "text/calendar" },
			},
		);
		const etag = putRes.headers.get("ETag")!;

		const getRes = await request(
			"GET",
			`/dav/projects/${calendarId}/etag-304-test.ics`,
			{ headers: { "If-None-Match": etag } },
		);
		expect(getRes.status).toBe(304);
		expect(getRes.headers.get("ETag")).toBe(etag);
		const body = await getRes.text();
		expect(body).toBe("");
	});

	it("GET with non-matching If-None-Match returns 200 with body", async () => {
		const ics = makeVtodo("etag-200-test", "200 Test");
		await request(
			"PUT",
			`/dav/projects/${calendarId}/etag-200-test.ics`,
			{
				body: ics,
				headers: { "Content-Type": "text/calendar" },
			},
		);

		const getRes = await request(
			"GET",
			`/dav/projects/${calendarId}/etag-200-test.ics`,
			{ headers: { "If-None-Match": '"stale-etag"' } },
		);
		expect(getRes.status).toBe(200);
		const body = await getRes.text();
		expect(body).toContain("VTODO");
	});

	it("GET without If-None-Match returns 200 with body", async () => {
		const ics = makeVtodo("etag-no-inm", "No INM Test");
		await request(
			"PUT",
			`/dav/projects/${calendarId}/etag-no-inm.ics`,
			{
				body: ics,
				headers: { "Content-Type": "text/calendar" },
			},
		);

		const getRes = await request(
			"GET",
			`/dav/projects/${calendarId}/etag-no-inm.ics`,
		);
		expect(getRes.status).toBe(200);
		const body = await getRes.text();
		expect(body).toContain("VTODO");
	});
});

// === 14. CalDAV edge cases ===

describe("CalDAV edge cases", () => {
	let calendarId: number;
	beforeAll(async () => {
		calendarId = await seedCalendar("Edge Case Calendar", "VTODO");
	});

	it("PUT with If-Match succeeds when ETag matches", async () => {
		const ics1 = makeVtodo("ifmatch-1", "Original");
		const putRes = await request(
			"PUT",
			`/dav/projects/${calendarId}/ifmatch-1.ics`,
			{
				body: ics1,
				headers: { "Content-Type": "text/calendar" },
			},
		);
		expect(putRes.status).toBe(201);
		const etag = putRes.headers.get("ETag")!;

		const ics2 = makeVtodo("ifmatch-1", "Updated via If-Match");
		const updateRes = await request(
			"PUT",
			`/dav/projects/${calendarId}/ifmatch-1.ics`,
			{
				body: ics2,
				headers: {
					"Content-Type": "text/calendar",
					"If-Match": etag,
				},
			},
		);
		expect(updateRes.status).toBe(204);
	});

	it("PUT with If-Match fails when ETag does not match (412)", async () => {
		const ics1 = makeVtodo("ifmatch-2", "Original");
		await request(
			"PUT",
			`/dav/projects/${calendarId}/ifmatch-2.ics`,
			{
				body: ics1,
				headers: { "Content-Type": "text/calendar" },
			},
		);

		const ics2 = makeVtodo("ifmatch-2", "Bad update");
		const updateRes = await request(
			"PUT",
			`/dav/projects/${calendarId}/ifmatch-2.ics`,
			{
				body: ics2,
				headers: {
					"Content-Type": "text/calendar",
					"If-Match": '"wrong-etag-value"',
				},
			},
		);
		expect(updateRes.status).toBe(412);
	});

	it("PUT with If-Match: * fails when object does not exist (412)", async () => {
		const ics = makeVtodo("ifmatch-star-missing", "Does not exist yet");
		const res = await request(
			"PUT",
			`/dav/projects/${calendarId}/ifmatch-star-missing.ics`,
			{
				body: ics,
				headers: {
					"Content-Type": "text/calendar",
					"If-Match": "*",
				},
			},
		);
		expect(res.status).toBe(412);
	});

	it("PROPFIND /dav/projects/ with Depth:1 lists calendars", async () => {
		const res = await request("PROPFIND", "/dav/projects/", {
			headers: { Depth: "1" },
		});
		expect(res.status).toBe(207);
		const xml = await res.text();
		expect(xml).toContain("Edge Case Calendar");
		expect(xml).toContain(`/dav/projects/${calendarId}/`);
	});

	it("DELETE non-existent object returns 404", async () => {
		const res = await request(
			"DELETE",
			`/dav/projects/${calendarId}/completely-nonexistent.ics`,
		);
		expect(res.status).toBe(404);
	});

	it("PUT empty body returns 400", async () => {
		const res = await request(
			"PUT",
			`/dav/projects/${calendarId}/empty-body.ics`,
			{
				body: "",
				headers: { "Content-Type": "text/calendar" },
			},
		);
		expect(res.status).toBe(400);
	});

	it("OPTIONS on /dav/ returns DAV header with correct capabilities", async () => {
		const res = await request("OPTIONS", "/dav/");
		expect(res.status).toBe(204);
		const dav = res.headers.get("DAV");
		expect(dav).toContain("calendar-access");
		expect(dav).toContain("sync-collection");
		expect(dav).toContain("extended-mkcol");
		const allow = res.headers.get("Allow");
		expect(allow).toContain("PROPFIND");
		expect(allow).toContain("REPORT");
		expect(allow).toContain("PUT");
		expect(allow).toContain("DELETE");
		expect(allow).toContain("MKCOL");
		expect(allow).toContain("MKCALENDAR");
	});

	it("DELETE with If-Match fails when ETag does not match (412)", async () => {
		const ics = makeVtodo("del-ifmatch-1", "Conditional delete");
		await request(
			"PUT",
			`/dav/projects/${calendarId}/del-ifmatch-1.ics`,
			{
				body: ics,
				headers: { "Content-Type": "text/calendar" },
			},
		);

		const res = await request(
			"DELETE",
			`/dav/projects/${calendarId}/del-ifmatch-1.ics`,
			{
				headers: { "If-Match": '"wrong-etag"' },
			},
		);
		expect(res.status).toBe(412);
	});

	it("PUT with If-None-Match: * on a new resource succeeds (201)", async () => {
		const ics = makeVtodo("ifnonematch-new", "Brand new task");
		const res = await request(
			"PUT",
			`/dav/projects/${calendarId}/ifnonematch-new.ics`,
			{
				body: ics,
				headers: {
					"Content-Type": "text/calendar",
					"If-None-Match": "*",
				},
			},
		);
		expect(res.status).toBe(201);
		expect(res.headers.get("ETag")).toBeTruthy();
	});

	it("PUT with If-None-Match: * on existing resource returns 412", async () => {
		const ics1 = makeVtodo("ifnonematch-exist", "Already here");
		await request(
			"PUT",
			`/dav/projects/${calendarId}/ifnonematch-exist.ics`,
			{
				body: ics1,
				headers: { "Content-Type": "text/calendar" },
			},
		);

		const ics2 = makeVtodo("ifnonematch-exist", "Try overwrite");
		const res = await request(
			"PUT",
			`/dav/projects/${calendarId}/ifnonematch-exist.ics`,
			{
				body: ics2,
				headers: {
					"Content-Type": "text/calendar",
					"If-None-Match": "*",
				},
			},
		);
		expect(res.status).toBe(412);
	});
});

// === 15. PROPFIND property filtering ===

describe("PROPFIND property filtering", () => {
	let calendarId: number;
	beforeAll(async () => {
		calendarId = await seedCalendar("PropFilter Test", "VTODO");
		const ics = makeVtodo("propfilter-1", "Filter test item");
		await request(
			"PUT",
			`/dav/projects/${calendarId}/propfilter-1.ics`,
			{
				body: ics,
				headers: { "Content-Type": "text/calendar" },
			},
		);
	});

	it("returns only getetag when only getetag is requested", async () => {
		const body = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:getetag/>
  </d:prop>
</d:propfind>`;

		const res = await request("PROPFIND", `/dav/projects/${calendarId}/`, {
			body,
			headers: { Depth: "1" },
		});
		expect(res.status).toBe(207);
		const xml = await res.text();
		expect(xml).toContain("getetag");
		expect(xml).not.toContain("<d:displayname>");
		expect(xml).not.toContain("getcontenttype");
		expect(xml).not.toContain("supported-report-set");
	});

	it("returns only displayname when only displayname is requested", async () => {
		const body = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/>
  </d:prop>
</d:propfind>`;

		const res = await request("PROPFIND", `/dav/projects/${calendarId}/`, {
			body,
			headers: { Depth: "0" },
		});
		expect(res.status).toBe(207);
		const xml = await res.text();
		expect(xml).toContain("<d:displayname>");
		expect(xml).not.toContain("getetag");
		expect(xml).not.toContain("getctag");
	});

	it("returns all props when no body is sent", async () => {
		const res = await request("PROPFIND", `/dav/projects/${calendarId}/`, {
			headers: { Depth: "0" },
		});
		expect(res.status).toBe(207);
		const xml = await res.text();
		expect(xml).toContain("<d:displayname>");
		expect(xml).toContain("resourcetype");
		expect(xml).toContain("getctag");
	});

	it("returns all props with allprop", async () => {
		const body = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:">
  <d:allprop/>
</d:propfind>`;

		const res = await request("PROPFIND", `/dav/projects/${calendarId}/`, {
			body,
			headers: { Depth: "0" },
		});
		expect(res.status).toBe(207);
		const xml = await res.text();
		expect(xml).toContain("<d:displayname>");
		expect(xml).toContain("resourcetype");
		expect(xml).toContain("getctag");
	});
});

// === 16. Duplicate UID rejection (RFC 4791) ===

describe("Duplicate UID rejection", () => {
	let calendarId: number;
	beforeAll(async () => {
		calendarId = await seedCalendar("Dup UID Test", "VTODO");
	});

	it("PUT with new UID succeeds (201)", async () => {
		const ics = makeVtodo("dup-uid-1", "First task");
		const res = await request(
			"PUT",
			`/dav/projects/${calendarId}/dup-uid-1.ics`,
			{
				body: ics,
				headers: { "Content-Type": "text/calendar" },
			},
		);
		expect(res.status).toBe(201);
	});

	it("PUT with same UID to different resource path returns 409", async () => {
		// First, create a resource with UID "dup-uid-2"
		const ics1 = makeVtodo("dup-uid-2", "Original task");
		const res1 = await request(
			"PUT",
			`/dav/projects/${calendarId}/dup-uid-2.ics`,
			{
				body: ics1,
				headers: { "Content-Type": "text/calendar" },
			},
		);
		expect(res1.status).toBe(201);

		// Now try to create a different resource with the same UID inside the ICS
		const ics2 = makeVtodo("dup-uid-2", "Duplicate task");
		const res2 = await request(
			"PUT",
			`/dav/projects/${calendarId}/different-resource.ics`,
			{
				body: ics2,
				headers: { "Content-Type": "text/calendar" },
			},
		);
		expect(res2.status).toBe(409);
		const text = await res2.text();
		expect(text).toContain("Duplicate UID");
	});

	it("PUT update to same resource path (same UID) succeeds", async () => {
		// Create a resource
		const ics1 = makeVtodo("dup-uid-3", "Original");
		const res1 = await request(
			"PUT",
			`/dav/projects/${calendarId}/dup-uid-3.ics`,
			{
				body: ics1,
				headers: { "Content-Type": "text/calendar" },
			},
		);
		expect(res1.status).toBe(201);

		// Update the same resource (same URL, same UID)
		const ics2 = makeVtodo("dup-uid-3", "Updated");
		const res2 = await request(
			"PUT",
			`/dav/projects/${calendarId}/dup-uid-3.ics`,
			{
				body: ics2,
				headers: { "Content-Type": "text/calendar" },
			},
		);
		expect(res2.status).toBe(204);
	});
});

describe("CalDAV edge cases", () => {
	let calendarId: number;

	beforeAll(async () => {
		await env.DB.prepare(
			"INSERT INTO calendars (user_id, name, component_type) VALUES (?, ?, ?)",
		)
			.bind("default", "Edge Case Cal", "VTODO")
			.run();
		const row = await env.DB.prepare(
			"SELECT id FROM calendars WHERE user_id = ? AND name = ? ORDER BY id DESC LIMIT 1",
		)
			.bind("default", "Edge Case Cal")
			.first<{ id: number }>();
		calendarId = row!.id;
	});

	it("handles malformed percent-encoded UID gracefully", async () => {
		const res = await request("GET", `/dav/projects/${calendarId}/%ZZinvalid.ics`);
		expect(res.status).toBe(404);
	});

	it("rejects invalid sync-token with 400", async () => {
		const body = `<?xml version="1.0" encoding="UTF-8"?>
<d:sync-collection xmlns:d="DAV:">
  <d:sync-token>not-a-number</d:sync-token>
  <d:prop>
    <d:getetag/>
  </d:prop>
</d:sync-collection>`;
		const res = await request("REPORT", `/dav/projects/${calendarId}/`, {
			body,
		});
		expect(res.status).toBe(400);
		const text = await res.text();
		expect(text).toContain("Invalid sync-token");
	});

	it("accepts valid numeric sync-token", async () => {
		const body = `<?xml version="1.0" encoding="UTF-8"?>
<d:sync-collection xmlns:d="DAV:">
  <d:sync-token>0</d:sync-token>
  <d:prop>
    <d:getetag/>
  </d:prop>
</d:sync-collection>`;
		const res = await request("REPORT", `/dav/projects/${calendarId}/`, {
			body,
		});
		expect(res.status).toBe(207);
	});
});

// === Depth:infinity rejection ===

describe("Depth:infinity rejection", () => {
	let calendarId: number;
	beforeAll(async () => {
		calendarId = await seedCalendar("Depth Infinity Test", "VTODO");
	});

	it("PROPFIND with Depth:infinity returns 403", async () => {
		const res = await request("PROPFIND", `/dav/projects/${calendarId}/`, {
			headers: { Depth: "infinity" },
		});
		expect(res.status).toBe(403);
		const xml = await res.text();
		expect(xml).toContain("propfind-finite-depth");
	});

	it("REPORT with Depth:infinity returns 403", async () => {
		const body = `<?xml version="1.0" encoding="UTF-8"?>
<d:sync-collection xmlns:d="DAV:">
  <d:sync-token></d:sync-token>
  <d:prop><d:getetag/></d:prop>
</d:sync-collection>`;
		const res = await request("REPORT", `/dav/projects/${calendarId}/`, {
			body,
			headers: { Depth: "infinity" },
		});
		expect(res.status).toBe(403);
		const xml = await res.text();
		expect(xml).toContain("propfind-finite-depth");
	});
});

// === Non-ASCII content ===

describe("Non-ASCII content", () => {
	let calendarId: number;
	beforeAll(async () => {
		calendarId = await seedCalendar("Non-ASCII Test", "VTODO");
		// Seed all non-ASCII objects upfront so REPORT tests can find them
		const jpIcs = makeVtodo("nonascii-jp-1", "牛乳を買う");
		await request("PUT", `/dav/projects/${calendarId}/nonascii-jp-1.ics`, {
			body: jpIcs,
			headers: { "Content-Type": "text/calendar" },
		});
		const emojiIcs = makeVtodo("nonascii-emoji-1", "Buy groceries 🛒🍎");
		await request(
			"PUT",
			`/dav/projects/${calendarId}/nonascii-emoji-1.ics`,
			{
				body: emojiIcs,
				headers: { "Content-Type": "text/calendar" },
			},
		);
		const cnIcs = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//Test//Test//EN",
			"BEGIN:VTODO",
			"UID:nonascii-cn-1",
			"DTSTAMP:20250101T000000Z",
			"SUMMARY:中文任务",
			"DESCRIPTION:这是一个用中文描述的任务，需要在周五之前完成。",
			"STATUS:NEEDS-ACTION",
			"END:VTODO",
			"END:VCALENDAR",
		].join("\r\n");
		await request("PUT", `/dav/projects/${calendarId}/nonascii-cn-1.ics`, {
			body: cnIcs,
			headers: { "Content-Type": "text/calendar" },
		});
	});

	it("PUT VTODO with Japanese SUMMARY succeeds and GET returns correct data", async () => {
		const getRes = await request(
			"GET",
			`/dav/projects/${calendarId}/nonascii-jp-1.ics`,
		);
		expect(getRes.status).toBe(200);
		const text = await getRes.text();
		expect(text).toContain("牛乳を買う");
	});

	it("PUT VTODO with emoji in SUMMARY succeeds and GET returns correct data", async () => {
		const getRes = await request(
			"GET",
			`/dav/projects/${calendarId}/nonascii-emoji-1.ics`,
		);
		expect(getRes.status).toBe(200);
		const text = await getRes.text();
		expect(text).toContain("Buy groceries 🛒🍎");
	});

	it("PUT VTODO with Chinese characters in DESCRIPTION succeeds", async () => {
		const getRes = await request(
			"GET",
			`/dav/projects/${calendarId}/nonascii-cn-1.ics`,
		);
		expect(getRes.status).toBe(200);
		const text = await getRes.text();
		expect(text).toContain("中文任务");
		expect(text).toContain("这是一个用中文描述的任务，需要在周五之前完成。");
	});

	it("REPORT lists non-ASCII objects correctly", async () => {
		const body = `<?xml version="1.0" encoding="UTF-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VTODO"/>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;

		const res = await request("REPORT", `/dav/projects/${calendarId}/`, {
			body,
		});
		expect(res.status).toBe(207);
		const xml = await res.text();
		expect(xml).toContain("牛乳を買う");
		expect(xml).toContain("Buy groceries 🛒🍎");
		expect(xml).toContain("中文任务");
	});

	it("Calendar-query filter text-match works with non-ASCII text", async () => {
		const body = `<?xml version="1.0" encoding="UTF-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VTODO">
        <c:prop-filter name="SUMMARY">
          <c:text-match collation="i;unicode-casemap" match-type="contains">牛乳</c:text-match>
        </c:prop-filter>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;

		const res = await request("REPORT", `/dav/projects/${calendarId}/`, {
			body,
		});
		expect(res.status).toBe(207);
		const xml = await res.text();
		expect(xml).toContain("牛乳を買う");
		expect(xml).not.toContain("Buy groceries");
		expect(xml).not.toContain("中文任务");
	});
});

// === DELETE calendar collection ===

describe("DELETE calendar collection", () => {
	it("DELETE on calendar collection returns 204", async () => {
		const calendarId = await seedCalendar("Delete Me Calendar", "VTODO");

		// Add an object to the calendar
		const ics = makeVtodo("del-cal-obj-1", "Task in deleted calendar");
		await request("PUT", `/dav/projects/${calendarId}/del-cal-obj-1.ics`, {
			body: ics,
			headers: { "Content-Type": "text/calendar" },
		});

		const res = await request("DELETE", `/dav/projects/${calendarId}/`);
		expect(res.status).toBe(204);
	});

	it("GET on deleted calendar returns 404", async () => {
		const calendarId = await seedCalendar("Delete Me Calendar 2", "VTODO");

		const res1 = await request("DELETE", `/dav/projects/${calendarId}/`);
		expect(res1.status).toBe(204);

		// PROPFIND on deleted calendar should return 404
		const res2 = await request("PROPFIND", `/dav/projects/${calendarId}/`, {
			headers: { Depth: "0" },
		});
		expect(res2.status).toBe(404);
	});

	it("Objects in deleted calendar are also gone", async () => {
		const calendarId = await seedCalendar("Delete Me Calendar 3", "VTODO");

		// Add objects
		const ics1 = makeVtodo("del-cal-obj-2", "Task A");
		const ics2 = makeVtodo("del-cal-obj-3", "Task B");
		await request("PUT", `/dav/projects/${calendarId}/del-cal-obj-2.ics`, {
			body: ics1,
			headers: { "Content-Type": "text/calendar" },
		});
		await request("PUT", `/dav/projects/${calendarId}/del-cal-obj-3.ics`, {
			body: ics2,
			headers: { "Content-Type": "text/calendar" },
		});

		// Delete the calendar
		await request("DELETE", `/dav/projects/${calendarId}/`);

		// Verify objects are gone (GET on objects should return 404 since calendar is gone)
		const res1 = await request(
			"GET",
			`/dav/projects/${calendarId}/del-cal-obj-2.ics`,
		);
		expect(res1.status).toBe(404);

		const res2 = await request(
			"GET",
			`/dav/projects/${calendarId}/del-cal-obj-3.ics`,
		);
		expect(res2.status).toBe(404);
	});

	it("DELETE on non-existent calendar returns 404", async () => {
		const res = await request("DELETE", "/dav/projects/99999/");
		expect(res.status).toBe(404);
	});
});

// === Edge case coverage ===

describe("Edge case coverage", () => {
	it("Cross-user calendar access via DELETE returns 404", async () => {
		const calendarId = await seedCalendar(
			"cross-user-delete-test",
			"VTODO",
		);
		const ics = makeVtodo("cross-user-obj", "Cross user task");
		await request("PUT", `/dav/projects/${calendarId}/cross-user-obj.ics`, {
			body: ics,
			headers: { "Content-Type": "text/calendar" },
		});

		// Try to DELETE with a different user's credentials
		const AUTH_OTHER = "Basic " + btoa("other-user:other-pass");
		const res = await SELF.fetch(
			`http://localhost/dav/projects/${calendarId}/`,
			{
				method: "DELETE",
				headers: { Authorization: AUTH_OTHER },
			},
		);

		// Should be 404 (calendar not found for that user) or 401 (auth failure)
		expect([401, 404]).toContain(res.status);
	});
});

// === PROPFIND ETag / If-None-Match caching ===

describe("PROPFIND ETag caching", () => {
	let calendarId: number;

	beforeAll(async () => {
		calendarId = await seedCalendar("ETag Cache Test", "VTODO");
	});

	it("PROPFIND response includes ETag header", async () => {
		const res = await request("PROPFIND", `/dav/projects/${calendarId}/`, {
			headers: { Depth: "0" },
		});
		expect(res.status).toBe(207);
		const etag = res.headers.get("etag");
		expect(etag).toBeTruthy();
	});

	it("PROPFIND with matching If-None-Match returns 304", async () => {
		// First request to get the ETag
		const res1 = await request("PROPFIND", `/dav/projects/${calendarId}/`, {
			headers: { Depth: "0" },
		});
		expect(res1.status).toBe(207);
		const etag = res1.headers.get("etag");
		expect(etag).toBeTruthy();

		// Second request with If-None-Match
		const res2 = await request("PROPFIND", `/dav/projects/${calendarId}/`, {
			headers: { Depth: "0", "If-None-Match": etag! },
		});
		expect(res2.status).toBe(304);
	});

	it("PROPFIND with stale If-None-Match returns 207 with body", async () => {
		// First request to get the ETag
		const res1 = await request("PROPFIND", `/dav/projects/${calendarId}/`, {
			headers: { Depth: "0" },
		});
		expect(res1.status).toBe(207);
		const etag = res1.headers.get("etag");
		expect(etag).toBeTruthy();

		// Modify the calendar to change the ctag
		const ics = makeVtodo("etag-test-obj", "ETag test task");
		await request("PUT", `/dav/projects/${calendarId}/etag-test-obj.ics`, {
			body: ics,
			headers: { "Content-Type": "text/calendar" },
		});

		// Request with the old (stale) ETag
		const res2 = await request("PROPFIND", `/dav/projects/${calendarId}/`, {
			headers: { Depth: "0", "If-None-Match": etag! },
		});
		expect(res2.status).toBe(207);
		const xml = await res2.text();
		expect(xml).toContain("multistatus");
	});
});

// === Health check ===

describe("Health check", () => {
	it("GET /health returns ok with DB status", async () => {
		const res = await SELF.fetch("http://localhost/health");
		expect(res.status).toBe(200);
		const body = await res.json<{ status: string; db: string }>();
		expect(body.status).toBe("ok");
		expect(body.db).toBe("connected");
	});
});
