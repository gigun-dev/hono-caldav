import { describe, it, expect } from "vitest";
import "../src/index";
import { request } from "./helpers.js";

describe("/.well-known/caldav", () => {
	it("GET redirects to /dav/ with 301", async () => {
		const res = await request("GET", "/.well-known/caldav");
		expect(res.status).toBe(301);
		expect(res.headers.get("Location")).toBe("/dav/");
	});

	it("PROPFIND redirects to /dav/ with 301", async () => {
		const res = await request("PROPFIND", "/.well-known/caldav");
		expect(res.status).toBe(301);
		expect(res.headers.get("Location")).toBe("/dav/");
	});

	it("OPTIONS returns DAV headers", async () => {
		const res = await request("OPTIONS", "/.well-known/caldav");
		expect(res.status).toBe(204);
		expect(res.headers.get("DAV")).toContain("calendar-access");
	});
});
