import { describe, it, expect, beforeAll } from "vitest";
import "../src/index";
import { request, seedCalendar } from "./helpers.js";

describe("Body size limit (256KB)", () => {
	let calendarId: number;

	beforeAll(async () => {
		calendarId = await seedCalendar("Body Limit Test", "VTODO");
	});

	it("PUT with body > 256KB returns 413", async () => {
		const largeBody = "X".repeat(257 * 1024);
		const res = await request(
			"PUT",
			`/dav/projects/${calendarId}/large.ics`,
			{
				body: largeBody,
				headers: {
					"Content-Type": "text/calendar",
					"Content-Length": String(largeBody.length),
				},
			},
		);
		expect(res.status).toBe(413);
	});

	it("PUT with Content-Length header > 256KB returns 413", async () => {
		const res = await request(
			"PUT",
			`/dav/projects/${calendarId}/large-header.ics`,
			{
				body: "small body",
				headers: {
					"Content-Type": "text/calendar",
					"Content-Length": "300000",
				},
			},
		);
		expect(res.status).toBe(413);
	});

	it("PROPPATCH with body > 256KB returns 413", async () => {
		const largeBody = `<?xml version="1.0"?><d:propertyupdate xmlns:d="DAV:"><d:set><d:prop><d:displayname>${"A".repeat(257 * 1024)}</d:displayname></d:prop></d:set></d:propertyupdate>`;
		const res = await request(
			"PROPPATCH",
			`/dav/projects/${calendarId}/`,
			{
				body: largeBody,
				headers: { "Content-Length": String(largeBody.length) },
			},
		);
		expect(res.status).toBe(413);
	});
});
