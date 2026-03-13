import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import "../src/index";

// --- Helpers ---

// App Password auth: email:app-password
const AUTH = "Basic " + btoa("admin:changeme");
const AUTH_BAD = "Basic " + btoa("admin:wrong-password");

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
		expect(xml).toContain("/dav/principals/admin/");
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
		expect(xml).toContain("/dav/principals/admin/");
	});

	it("PROPFIND /dav/principals/admin returns calendar-home-set", async () => {
		const res = await request(
			"PROPFIND",
			"/dav/principals/admin",
		);
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
		expect(res2.status).toBe(200);
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
		const ics1 = makeVtodo("sync-add-base", "Base");
		await request("PUT", `/dav/projects/${calendarId}/sync-add-base.ics`, {
			body: ics1,
			headers: { "Content-Type": "text/calendar" },
		});

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

		const ics2 = makeVtodo("sync-add-new", "New sync item");
		await request("PUT", `/dav/projects/${calendarId}/sync-add-new.ics`, {
			body: ics2,
			headers: { "Content-Type": "text/calendar" },
		});

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
		expect(xml2).not.toContain("sync-add-base");
	});

	it("incremental sync detects deletions", async () => {
		const ics = makeVtodo("sync-del-target", "Will delete");
		await request("PUT", `/dav/projects/${calendarId}/sync-del-target.ics`, {
			body: ics,
			headers: { "Content-Type": "text/calendar" },
		});

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

		await request("DELETE", `/dav/projects/${calendarId}/sync-del-target.ics`);

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
});

// === 14. PROPFIND property filtering ===

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
