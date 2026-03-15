import { describe, it, expect, beforeAll } from "vitest";
import "../src/index";
import { request, makeVtodo, seedCalendar } from "./helpers.js";

describe("If-Match conditional requests", () => {
	let calendarId: number;

	beforeAll(async () => {
		calendarId = await seedCalendar("If-Match Test", "VTODO");
	});

	// --- PUT with If-Match ---

	it("PUT with matching If-Match succeeds", async () => {
		const ics = makeVtodo("ifm-put-1", "Original");
		const putRes = await request(
			"PUT",
			`/dav/projects/${calendarId}/ifm-put-1.ics`,
			{ body: ics, headers: { "Content-Type": "text/calendar" } },
		);
		const etag = putRes.headers.get("ETag")!;

		const ics2 = makeVtodo("ifm-put-1", "Updated");
		const res = await request(
			"PUT",
			`/dav/projects/${calendarId}/ifm-put-1.ics`,
			{
				body: ics2,
				headers: {
					"Content-Type": "text/calendar",
					"If-Match": etag,
				},
			},
		);
		expect(res.status).toBe(200);
	});

	it("PUT with wrong If-Match returns 412", async () => {
		const ics = makeVtodo("ifm-put-2", "Original");
		await request("PUT", `/dav/projects/${calendarId}/ifm-put-2.ics`, {
			body: ics,
			headers: { "Content-Type": "text/calendar" },
		});

		const ics2 = makeVtodo("ifm-put-2", "Updated");
		const res = await request(
			"PUT",
			`/dav/projects/${calendarId}/ifm-put-2.ics`,
			{
				body: ics2,
				headers: {
					"Content-Type": "text/calendar",
					"If-Match": '"wrong-etag"',
				},
			},
		);
		expect(res.status).toBe(412);
	});

	it("PUT with If-Match: * on non-existent object returns 412", async () => {
		const ics = makeVtodo("ifm-put-star", "Star");
		const res = await request(
			"PUT",
			`/dav/projects/${calendarId}/ifm-put-star.ics`,
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

	it("PUT with If-Match: * on existing object succeeds", async () => {
		const ics = makeVtodo("ifm-put-star2", "Exists");
		await request(
			"PUT",
			`/dav/projects/${calendarId}/ifm-put-star2.ics`,
			{ body: ics, headers: { "Content-Type": "text/calendar" } },
		);

		const ics2 = makeVtodo("ifm-put-star2", "Updated");
		const res = await request(
			"PUT",
			`/dav/projects/${calendarId}/ifm-put-star2.ics`,
			{
				body: ics2,
				headers: {
					"Content-Type": "text/calendar",
					"If-Match": "*",
				},
			},
		);
		expect(res.status).toBe(200);
	});

	// --- DELETE with If-Match ---

	it("DELETE with matching If-Match succeeds", async () => {
		const ics = makeVtodo("ifm-del-1", "Delete me");
		const putRes = await request(
			"PUT",
			`/dav/projects/${calendarId}/ifm-del-1.ics`,
			{ body: ics, headers: { "Content-Type": "text/calendar" } },
		);
		const etag = putRes.headers.get("ETag")!;

		const res = await request(
			"DELETE",
			`/dav/projects/${calendarId}/ifm-del-1.ics`,
			{ headers: { "If-Match": etag } },
		);
		expect(res.status).toBe(204);
	});

	it("DELETE with wrong If-Match returns 412", async () => {
		const ics = makeVtodo("ifm-del-2", "Keep me");
		await request("PUT", `/dav/projects/${calendarId}/ifm-del-2.ics`, {
			body: ics,
			headers: { "Content-Type": "text/calendar" },
		});

		const res = await request(
			"DELETE",
			`/dav/projects/${calendarId}/ifm-del-2.ics`,
			{ headers: { "If-Match": '"wrong-etag"' } },
		);
		expect(res.status).toBe(412);
	});

	it("DELETE with If-Match: * on non-existent returns 412", async () => {
		const res = await request(
			"DELETE",
			`/dav/projects/${calendarId}/ifm-del-nonexist.ics`,
			{ headers: { "If-Match": "*" } },
		);
		expect(res.status).toBe(412);
	});
});
