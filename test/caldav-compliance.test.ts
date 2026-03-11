import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import "../src/index.js";

// --- Helpers (matching existing test patterns) ---

const AUTH = "Basic " + btoa("test-user:test-pass");

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

function makeVtodo(
	uid: string,
	summary: string,
	extra: string = "",
): string {
	return [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Test//Test//EN",
		"BEGIN:VTODO",
		`UID:${uid}`,
		`DTSTAMP:20250101T000000Z`,
		`SUMMARY:${summary}`,
		"STATUS:NEEDS-ACTION",
		extra,
		"END:VTODO",
		"END:VCALENDAR",
	]
		.filter(Boolean)
		.join("\r\n");
}

function makeVevent(
	uid: string,
	summary: string,
	dtstart: string = "20250115T090000Z",
	dtend: string = "20250115T100000Z",
): string {
	return [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Test//Test//EN",
		"BEGIN:VEVENT",
		`UID:${uid}`,
		`DTSTAMP:20250101T000000Z`,
		`DTSTART:${dtstart}`,
		`DTEND:${dtend}`,
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

// =============================================================================
// 1. CalDAV Discovery Flow (iOS initial connection simulation)
// =============================================================================

describe("CalDAV Discovery Flow", () => {
	it("GET /.well-known/caldav returns 301 redirect to /dav/", async () => {
		const res = await request("GET", "/.well-known/caldav");
		expect(res.status).toBe(301);
		expect(res.headers.get("location")).toBe("/dav/");
	});

	it("PROPFIND /.well-known/caldav returns 301 redirect to /dav/", async () => {
		const res = await request("PROPFIND", "/.well-known/caldav");
		expect(res.status).toBe(301);
		expect(res.headers.get("location")).toBe("/dav/");
	});

	it("PROPFIND /dav/ (Depth:0) returns current-user-principal in 207", async () => {
		const res = await request("PROPFIND", "/dav/", {
			headers: { Depth: "0" },
			body: `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:current-user-principal/>
    <d:resourcetype/>
  </d:prop>
</d:propfind>`,
		});
		expect(res.status).toBe(207);
		const xml = await res.text();
		expect(xml).toContain("current-user-principal");
		expect(xml).toContain("/dav/principals/test-user/");
	});

	it("PROPFIND /dav/principals/{username} returns calendar-home-set in 207", async () => {
		const res = await request("PROPFIND", "/dav/principals/test-user/", {
			headers: { Depth: "0" },
			body: `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <c:calendar-home-set/>
    <d:current-user-principal/>
    <d:resourcetype/>
  </d:prop>
</d:propfind>`,
		});
		expect(res.status).toBe(207);
		const xml = await res.text();
		expect(xml).toContain("calendar-home-set");
		expect(xml).toContain("/dav/projects/");
	});

	it("PROPFIND /dav/projects/ (Depth:1) returns calendar listing", async () => {
		const calId = await seedCalendar("Discovery Test", "VTODO");
		const res = await request("PROPFIND", "/dav/projects/", {
			headers: { Depth: "1" },
			body: `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <cs:getctag/>
    <c:supported-calendar-component-set/>
  </d:prop>
</d:propfind>`,
		});
		expect(res.status).toBe(207);
		const xml = await res.text();
		// Should include the /dav/projects/ collection itself
		expect(xml).toContain("/dav/projects/");
		// Should include the calendar we seeded
		expect(xml).toContain(`/dav/projects/${calId}/`);
		expect(xml).toContain("Discovery Test");
		// Should include calendar resource type
		expect(xml).toContain("<c:calendar/>");
	});
});

// =============================================================================
// 2. Task CRUD Flow (iOS Reminders simulation)
// =============================================================================

describe("Task CRUD Flow", () => {
	let calId: number;

	beforeAll(async () => {
		calId = await seedCalendar("Reminders CRUD", "VTODO");
	});

	it("creates, reads, updates, completes, and deletes a task with ETag tracking", async () => {
		const uid = "crud-test-task-001";

		// --- Step 1: PUT (create) ---
		const createRes = await request(
			"PUT",
			`/dav/projects/${calId}/${uid}.ics`,
			{
				headers: {
					"Content-Type": "text/calendar; charset=utf-8",
					"If-None-Match": "*",
				},
				body: makeVtodo(uid, "Buy groceries"),
			},
		);
		expect(createRes.status).toBe(201);
		const etag1 = createRes.headers.get("ETag");
		expect(etag1).toBeTruthy();

		// --- Step 2: GET ---
		const getRes = await request(
			"GET",
			`/dav/projects/${calId}/${uid}.ics`,
		);
		expect(getRes.status).toBe(200);
		const icsBody = await getRes.text();
		expect(icsBody).toContain("SUMMARY:Buy groceries");
		expect(icsBody).toContain("STATUS:NEEDS-ACTION");
		expect(getRes.headers.get("ETag")).toBe(etag1);

		// --- Step 3: PUT (update summary) ---
		const updateRes = await request(
			"PUT",
			`/dav/projects/${calId}/${uid}.ics`,
			{
				headers: {
					"Content-Type": "text/calendar; charset=utf-8",
					"If-Match": etag1!,
				},
				body: makeVtodo(uid, "Buy organic groceries"),
			},
		);
		expect(updateRes.status).toBe(204);
		const etag2 = updateRes.headers.get("ETag");
		expect(etag2).toBeTruthy();
		expect(etag2).not.toBe(etag1);

		// --- Step 4: PUT (mark completed) ---
		const completeRes = await request(
			"PUT",
			`/dav/projects/${calId}/${uid}.ics`,
			{
				headers: {
					"Content-Type": "text/calendar; charset=utf-8",
					"If-Match": etag2!,
				},
				body: makeVtodo(
					uid,
					"Buy organic groceries",
					"STATUS:COMPLETED\r\nCOMPLETED:20250120T150000Z",
				),
			},
		);
		expect(completeRes.status).toBe(204);
		const etag3 = completeRes.headers.get("ETag");
		expect(etag3).toBeTruthy();

		// Verify completed status
		const getCompleted = await request(
			"GET",
			`/dav/projects/${calId}/${uid}.ics`,
		);
		const completedIcs = await getCompleted.text();
		expect(completedIcs).toContain("STATUS:COMPLETED");
		expect(completedIcs).toContain("COMPLETED:20250120T150000Z");

		// --- Step 5: DELETE ---
		const deleteRes = await request(
			"DELETE",
			`/dav/projects/${calId}/${uid}.ics`,
			{
				headers: { "If-Match": etag3! },
			},
		);
		expect(deleteRes.status).toBe(204);

		// Verify deleted
		const getDeleted = await request(
			"GET",
			`/dav/projects/${calId}/${uid}.ics`,
		);
		expect(getDeleted.status).toBe(404);
	});
});

// =============================================================================
// 3. Sync-collection Flow (incremental sync)
// =============================================================================

describe("Sync-collection Flow", () => {
	let calId: number;

	beforeAll(async () => {
		calId = await seedCalendar("Sync Test", "VTODO");
	});

	it("tracks additions and deletions via sync-token", async () => {
		// --- Step 1: Get initial sync-token via PROPFIND ---
		const propfindRes = await request(
			"PROPFIND",
			`/dav/projects/${calId}/`,
			{
				headers: { Depth: "0" },
				body: `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:sync-token/>
  </d:prop>
</d:propfind>`,
			},
		);
		expect(propfindRes.status).toBe(207);
		const propfindXml = await propfindRes.text();
		const initialTokenMatch = propfindXml.match(
			/<d:sync-token>(\d+)<\/d:sync-token>/,
		);
		expect(initialTokenMatch).toBeTruthy();
		const initialToken = initialTokenMatch![1];

		// --- Step 2: Add a task ---
		const uid1 = "sync-task-001";
		await request("PUT", `/dav/projects/${calId}/${uid1}.ics`, {
			headers: { "Content-Type": "text/calendar; charset=utf-8" },
			body: makeVtodo(uid1, "Sync task 1"),
		});

		// --- Step 3: REPORT sync-collection with initial token ---
		const syncRes1 = await request(
			"REPORT",
			`/dav/projects/${calId}/`,
			{
				headers: { Depth: "1" },
				body: `<?xml version="1.0" encoding="UTF-8"?>
<d:sync-collection xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:sync-token>${initialToken}</d:sync-token>
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
</d:sync-collection>`,
			},
		);
		expect(syncRes1.status).toBe(207);
		const syncXml1 = await syncRes1.text();
		// Should contain the added task
		expect(syncXml1).toContain(`${uid1}.ics`);
		expect(syncXml1).toContain("Sync task 1");
		// Should have updated sync-token
		const newTokenMatch1 = syncXml1.match(
			/<d:sync-token>(\d+)<\/d:sync-token>/,
		);
		expect(newTokenMatch1).toBeTruthy();
		const token2 = newTokenMatch1![1];
		expect(Number(token2)).toBeGreaterThan(Number(initialToken));

		// --- Step 4: Delete the task ---
		await request("DELETE", `/dav/projects/${calId}/${uid1}.ics`);

		// --- Step 5: Sync again - should show deletion ---
		const syncRes2 = await request(
			"REPORT",
			`/dav/projects/${calId}/`,
			{
				headers: { Depth: "1" },
				body: `<?xml version="1.0" encoding="UTF-8"?>
<d:sync-collection xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:sync-token>${token2}</d:sync-token>
  <d:prop>
    <d:getetag/>
  </d:prop>
</d:sync-collection>`,
			},
		);
		expect(syncRes2.status).toBe(207);
		const syncXml2 = await syncRes2.text();
		// Should report the deleted resource with 410 Gone
		expect(syncXml2).toContain(`${uid1}.ics`);
		expect(syncXml2).toContain("410 Gone");
	});

	it("returns all objects on full sync (no sync-token)", async () => {
		const uid = "sync-full-001";
		await request("PUT", `/dav/projects/${calId}/${uid}.ics`, {
			headers: { "Content-Type": "text/calendar; charset=utf-8" },
			body: makeVtodo(uid, "Full sync task"),
		});

		const res = await request("REPORT", `/dav/projects/${calId}/`, {
			headers: { Depth: "1" },
			body: `<?xml version="1.0" encoding="UTF-8"?>
<d:sync-collection xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:sync-token></d:sync-token>
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
</d:sync-collection>`,
		});
		expect(res.status).toBe(207);
		const xml = await res.text();
		expect(xml).toContain(`${uid}.ics`);
		expect(xml).toContain("Full sync task");
	});
});

// =============================================================================
// 4. Calendar-query REPORT
// =============================================================================

describe("Calendar-query REPORT", () => {
	let eventCalId: number;
	let todoCalId: number;

	beforeAll(async () => {
		eventCalId = await seedCalendar("Events Query", "VEVENT");
		todoCalId = await seedCalendar("Todos Query", "VTODO");

		// Add events at different times
		await request("PUT", `/dav/projects/${eventCalId}/event-jan.ics`, {
			headers: { "Content-Type": "text/calendar; charset=utf-8" },
			body: makeVevent(
				"event-jan",
				"January Meeting",
				"20250115T090000Z",
				"20250115T100000Z",
			),
		});
		await request("PUT", `/dav/projects/${eventCalId}/event-mar.ics`, {
			headers: { "Content-Type": "text/calendar; charset=utf-8" },
			body: makeVevent(
				"event-mar",
				"March Meeting",
				"20250315T140000Z",
				"20250315T150000Z",
			),
		});

		// Add todos
		await request("PUT", `/dav/projects/${todoCalId}/todo-a.ics`, {
			headers: { "Content-Type": "text/calendar; charset=utf-8" },
			body: makeVtodo("todo-a", "Todo A"),
		});
		await request("PUT", `/dav/projects/${todoCalId}/todo-b.ics`, {
			headers: { "Content-Type": "text/calendar; charset=utf-8" },
			body: makeVtodo("todo-b", "Todo B"),
		});
	});

	it("VEVENT time-range filter returns only matching events", async () => {
		const res = await request(
			"REPORT",
			`/dav/projects/${eventCalId}/`,
			{
				headers: { Depth: "1" },
				body: `<?xml version="1.0" encoding="UTF-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="20250301T000000Z" end="20250401T000000Z"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`,
			},
		);
		expect(res.status).toBe(207);
		const xml = await res.text();
		// Should include March event
		expect(xml).toContain("March Meeting");
		// Should NOT include January event
		expect(xml).not.toContain("January Meeting");
	});

	it("VTODO comp-filter returns only VTODOs", async () => {
		const res = await request(
			"REPORT",
			`/dav/projects/${todoCalId}/`,
			{
				headers: { Depth: "1" },
				body: `<?xml version="1.0" encoding="UTF-8"?>
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
</c:calendar-query>`,
			},
		);
		expect(res.status).toBe(207);
		const xml = await res.text();
		expect(xml).toContain("Todo A");
		expect(xml).toContain("Todo B");
	});
});

// =============================================================================
// 5. MKCALENDAR (calendar creation)
// =============================================================================

describe("MKCALENDAR", () => {
	it("creates a calendar with displayname and supported-calendar-component-set", async () => {
		const res = await request("POST", "/dav/projects/", {
			headers: {
				"Content-Type": "application/xml; charset=utf-8",
				"X-Caldav-Method": "MKCALENDAR",
			},
			body: `<?xml version="1.0" encoding="UTF-8"?>
<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:set>
    <d:prop>
      <d:displayname>Work Tasks</d:displayname>
      <c:supported-calendar-component-set>
        <c:comp name="VTODO"/>
      </c:supported-calendar-component-set>
    </d:prop>
  </d:set>
</c:mkcalendar>`,
		});
		expect(res.status).toBe(201);
		const location = res.headers.get("Location");
		expect(location).toBeTruthy();
		expect(location).toMatch(/\/dav\/projects\/\d+\//);

		// Verify the created calendar via PROPFIND
		const propfindRes = await request("PROPFIND", location!, {
			headers: { Depth: "0" },
			body: `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:displayname/>
    <c:supported-calendar-component-set/>
  </d:prop>
</d:propfind>`,
		});
		expect(propfindRes.status).toBe(207);
		const xml = await propfindRes.text();
		expect(xml).toContain("Work Tasks");
		expect(xml).toContain('name="VTODO"');
	});

	it("creates a VEVENT calendar via MKCALENDAR", async () => {
		const res = await request("POST", "/dav/projects/", {
			headers: {
				"Content-Type": "application/xml; charset=utf-8",
				"X-Caldav-Method": "MKCALENDAR",
			},
			body: `<?xml version="1.0" encoding="UTF-8"?>
<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:set>
    <d:prop>
      <d:displayname>My Events</d:displayname>
      <c:supported-calendar-component-set>
        <c:comp name="VEVENT"/>
      </c:supported-calendar-component-set>
    </d:prop>
  </d:set>
</c:mkcalendar>`,
		});
		expect(res.status).toBe(201);
		const location = res.headers.get("Location")!;

		// Verify calendar type
		const propfindRes = await request("PROPFIND", location, {
			headers: { Depth: "0" },
			body: `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:displayname/>
    <c:supported-calendar-component-set/>
  </d:prop>
</d:propfind>`,
		});
		expect(propfindRes.status).toBe(207);
		const xml = await propfindRes.text();
		expect(xml).toContain("My Events");
		expect(xml).toContain('name="VEVENT"');
	});
});

// =============================================================================
// 6. Multi-calendar Isolation
// =============================================================================

describe("Multi-calendar Isolation", () => {
	let calA: number;
	let calB: number;

	beforeAll(async () => {
		calA = await seedCalendar("Calendar A", "VTODO");
		calB = await seedCalendar("Calendar B", "VTODO");

		// Add a task to Calendar A
		await request("PUT", `/dav/projects/${calA}/task-in-a.ics`, {
			headers: { "Content-Type": "text/calendar; charset=utf-8" },
			body: makeVtodo("task-in-a", "Task in Calendar A"),
		});

		// Add a task to Calendar B
		await request("PUT", `/dav/projects/${calB}/task-in-b.ics`, {
			headers: { "Content-Type": "text/calendar; charset=utf-8" },
			body: makeVtodo("task-in-b", "Task in Calendar B"),
		});
	});

	it("PROPFIND Depth:1 on Calendar A shows only its tasks", async () => {
		const res = await request("PROPFIND", `/dav/projects/${calA}/`, {
			headers: { Depth: "1" },
			body: `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:getetag/>
    <d:displayname/>
  </d:prop>
</d:propfind>`,
		});
		expect(res.status).toBe(207);
		const xml = await res.text();
		expect(xml).toContain("task-in-a.ics");
		expect(xml).not.toContain("task-in-b.ics");
	});

	it("PROPFIND Depth:1 on Calendar B shows only its tasks", async () => {
		const res = await request("PROPFIND", `/dav/projects/${calB}/`, {
			headers: { Depth: "1" },
			body: `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:getetag/>
    <d:displayname/>
  </d:prop>
</d:propfind>`,
		});
		expect(res.status).toBe(207);
		const xml = await res.text();
		expect(xml).toContain("task-in-b.ics");
		expect(xml).not.toContain("task-in-a.ics");
	});

	it("GET on Calendar A task from Calendar B returns 404", async () => {
		const res = await request(
			"GET",
			`/dav/projects/${calB}/task-in-a.ics`,
		);
		expect(res.status).toBe(404);
	});

	it("PROPFIND /dav/projects/ Depth:1 lists both calendars", async () => {
		const res = await request("PROPFIND", "/dav/projects/", {
			headers: { Depth: "1" },
			body: `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/>
  </d:prop>
</d:propfind>`,
		});
		expect(res.status).toBe(207);
		const xml = await res.text();
		expect(xml).toContain(`/dav/projects/${calA}/`);
		expect(xml).toContain(`/dav/projects/${calB}/`);
		expect(xml).toContain("Calendar A");
		expect(xml).toContain("Calendar B");
	});
});

// =============================================================================
// 7. ETag / Conditional Request Semantics
// =============================================================================

describe("ETag and Conditional Requests", () => {
	let calId: number;

	beforeAll(async () => {
		calId = await seedCalendar("ETag Test", "VTODO");
	});

	it("If-None-Match: * prevents overwrite of existing resource", async () => {
		const uid = "etag-test-001";
		// Create
		await request("PUT", `/dav/projects/${calId}/${uid}.ics`, {
			headers: {
				"Content-Type": "text/calendar; charset=utf-8",
				"If-None-Match": "*",
			},
			body: makeVtodo(uid, "Original"),
		});

		// Try to create again with If-None-Match: *
		const res = await request("PUT", `/dav/projects/${calId}/${uid}.ics`, {
			headers: {
				"Content-Type": "text/calendar; charset=utf-8",
				"If-None-Match": "*",
			},
			body: makeVtodo(uid, "Duplicate"),
		});
		expect(res.status).toBe(412);
	});

	it("If-Match with wrong ETag returns 412", async () => {
		const uid = "etag-test-002";
		await request("PUT", `/dav/projects/${calId}/${uid}.ics`, {
			headers: { "Content-Type": "text/calendar; charset=utf-8" },
			body: makeVtodo(uid, "ETag mismatch test"),
		});

		const res = await request("PUT", `/dav/projects/${calId}/${uid}.ics`, {
			headers: {
				"Content-Type": "text/calendar; charset=utf-8",
				"If-Match": '"wrong-etag"',
			},
			body: makeVtodo(uid, "Updated"),
		});
		expect(res.status).toBe(412);
	});

	it("GET with If-None-Match returns 304 for unchanged resource", async () => {
		const uid = "etag-test-003";
		const createRes = await request(
			"PUT",
			`/dav/projects/${calId}/${uid}.ics`,
			{
				headers: { "Content-Type": "text/calendar; charset=utf-8" },
				body: makeVtodo(uid, "304 test"),
			},
		);
		const etag = createRes.headers.get("ETag")!;

		const getRes = await request(
			"GET",
			`/dav/projects/${calId}/${uid}.ics`,
			{
				headers: { "If-None-Match": etag },
			},
		);
		expect(getRes.status).toBe(304);
	});
});

// =============================================================================
// 8. Calendar-multiget REPORT
// =============================================================================

describe("Calendar-multiget REPORT", () => {
	let calId: number;

	beforeAll(async () => {
		calId = await seedCalendar("Multiget Test", "VTODO");

		await request("PUT", `/dav/projects/${calId}/mg-task-1.ics`, {
			headers: { "Content-Type": "text/calendar; charset=utf-8" },
			body: makeVtodo("mg-task-1", "Multiget Task 1"),
		});
		await request("PUT", `/dav/projects/${calId}/mg-task-2.ics`, {
			headers: { "Content-Type": "text/calendar; charset=utf-8" },
			body: makeVtodo("mg-task-2", "Multiget Task 2"),
		});
		await request("PUT", `/dav/projects/${calId}/mg-task-3.ics`, {
			headers: { "Content-Type": "text/calendar; charset=utf-8" },
			body: makeVtodo("mg-task-3", "Multiget Task 3"),
		});
	});

	it("returns only requested resources by href", async () => {
		const res = await request("REPORT", `/dav/projects/${calId}/`, {
			headers: { Depth: "1" },
			body: `<?xml version="1.0" encoding="UTF-8"?>
<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <d:href>/dav/projects/${calId}/mg-task-1.ics</d:href>
  <d:href>/dav/projects/${calId}/mg-task-3.ics</d:href>
</c:calendar-multiget>`,
		});
		expect(res.status).toBe(207);
		const xml = await res.text();
		expect(xml).toContain("Multiget Task 1");
		expect(xml).toContain("Multiget Task 3");
		// Task 2 was not requested
		expect(xml).not.toContain("Multiget Task 2");
	});

	it("returns 404 for non-existent href in multiget", async () => {
		const res = await request("REPORT", `/dav/projects/${calId}/`, {
			headers: { Depth: "1" },
			body: `<?xml version="1.0" encoding="UTF-8"?>
<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <d:href>/dav/projects/${calId}/nonexistent.ics</d:href>
</c:calendar-multiget>`,
		});
		expect(res.status).toBe(207);
		const xml = await res.text();
		expect(xml).toContain("404 Not Found");
	});
});

// =============================================================================
// 9. OPTIONS and DAV Headers
// =============================================================================

describe("OPTIONS and DAV Headers", () => {
	it("OPTIONS /dav/ returns correct DAV and Allow headers", async () => {
		const res = await request("OPTIONS", "/dav/");
		expect(res.status).toBe(204);
		const dav = res.headers.get("DAV");
		expect(dav).toContain("calendar-access");
		expect(dav).toContain("sync-collection");
		const allow = res.headers.get("Allow");
		expect(allow).toContain("PROPFIND");
		expect(allow).toContain("REPORT");
		expect(allow).toContain("PUT");
		expect(allow).toContain("DELETE");
		expect(allow).toContain("MKCALENDAR");
	});

	it("OPTIONS /.well-known/caldav returns DAV headers", async () => {
		const res = await request("OPTIONS", "/.well-known/caldav");
		expect(res.status).toBe(204);
		expect(res.headers.get("DAV")).toContain("calendar-access");
	});
});

// =============================================================================
// 10. Extended MKCOL (calendar creation via MKCOL)
// =============================================================================

describe("Extended MKCOL", () => {
	it("creates a calendar via MKCOL with resourcetype calendar", async () => {
		const res = await request("MKCOL", "/dav/projects/mkcol-test/", {
			headers: { "Content-Type": "application/xml; charset=utf-8" },
			body: `<?xml version="1.0" encoding="UTF-8"?>
<d:mkcol xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:set>
    <d:prop>
      <d:resourcetype>
        <d:collection/>
        <c:calendar/>
      </d:resourcetype>
      <d:displayname>MKCOL Calendar</d:displayname>
      <c:supported-calendar-component-set>
        <c:comp name="VEVENT"/>
      </c:supported-calendar-component-set>
    </d:prop>
  </d:set>
</d:mkcol>`,
		});
		expect(res.status).toBe(201);
		const location = res.headers.get("Location")!;

		// Verify via PROPFIND
		const propRes = await request("PROPFIND", location, {
			headers: { Depth: "0" },
			body: `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:displayname/>
    <c:supported-calendar-component-set/>
  </d:prop>
</d:propfind>`,
		});
		expect(propRes.status).toBe(207);
		const xml = await propRes.text();
		expect(xml).toContain("MKCOL Calendar");
		expect(xml).toContain('name="VEVENT"');
	});
});

// =============================================================================
// 11. PROPFIND Depth:infinity rejection
// =============================================================================

describe("PROPFIND Depth Handling", () => {
	let calId: number;

	beforeAll(async () => {
		calId = await seedCalendar("Depth Test", "VTODO");
	});

	it("rejects Depth:infinity with 403", async () => {
		const res = await request("PROPFIND", `/dav/projects/${calId}/`, {
			headers: { Depth: "infinity" },
		});
		expect(res.status).toBe(403);
		const xml = await res.text();
		expect(xml).toContain("propfind-finite-depth");
	});
});

// =============================================================================
// 12. Calendar Delete
// =============================================================================

describe("Calendar Delete", () => {
	it("deletes a calendar and its objects", async () => {
		const calId = await seedCalendar("To Delete", "VTODO");

		// Add a task
		await request("PUT", `/dav/projects/${calId}/del-task.ics`, {
			headers: { "Content-Type": "text/calendar; charset=utf-8" },
			body: makeVtodo("del-task", "Will be deleted"),
		});

		// Verify it exists
		const getRes = await request(
			"GET",
			`/dav/projects/${calId}/del-task.ics`,
		);
		expect(getRes.status).toBe(200);

		// Delete the calendar
		const delRes = await request("DELETE", `/dav/projects/${calId}/`);
		expect(delRes.status).toBe(204);

		// Calendar should no longer exist
		const propRes = await request("PROPFIND", `/dav/projects/${calId}/`, {
			headers: { Depth: "0" },
		});
		expect(propRes.status).toBe(404);
	});
});
