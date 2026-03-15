import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import "../src/index";
import { request } from "./helpers.js";

describe("MKCALENDAR proxy (POST + X-Caldav-Method)", () => {
	it("creates calendar when X-Caldav-Method: MKCALENDAR", async () => {
		const body = `<?xml version="1.0" encoding="UTF-8"?>
<B:mkcalendar xmlns:B="urn:ietf:params:xml:ns:caldav" xmlns:A="DAV:">
  <A:set>
    <A:prop>
      <A:displayname>Proxy Created</A:displayname>
    </A:prop>
  </A:set>
</B:mkcalendar>`;

		const res = await request("POST", "/dav/projects/proxy-test", {
			body,
			headers: { "X-Caldav-Method": "MKCALENDAR" },
		});
		expect(res.status).toBe(201);
		expect(res.headers.get("Location")).toMatch(/^\/dav\/projects\/\d+\/$/);
	});

	it("returns 405 without X-Caldav-Method header", async () => {
		const res = await request("POST", "/dav/projects/no-header", {
			body: "<test/>",
		});
		expect(res.status).toBe(405);
	});

	it("returns 405 with wrong X-Caldav-Method value", async () => {
		const res = await request("POST", "/dav/projects/wrong-method", {
			body: "<test/>",
			headers: { "X-Caldav-Method": "REPORT" },
		});
		expect(res.status).toBe(405);
	});

	it("returns 401 without authentication", async () => {
		const res = await SELF.fetch("http://localhost/dav/projects/unauth", {
			method: "POST",
			headers: { "X-Caldav-Method": "MKCALENDAR" },
			body: "<test/>",
		});
		expect(res.status).toBe(401);
	});
});
