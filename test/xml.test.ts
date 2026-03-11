import { describe, it, expect } from "vitest";
import {
	parsePropFilter,
	getDepthHeader,
	calendarCollectionProps,
} from "../src/caldav/xml.js";
import type { Calendar } from "../src/caldav/storage.js";

describe("parsePropFilter", () => {
	it("returns allprop for empty body", () => {
		expect(parsePropFilter("")).toBe("allprop");
	});

	it("returns allprop for whitespace-only body", () => {
		expect(parsePropFilter("   \n  ")).toBe("allprop");
	});

	it("returns allprop for <d:allprop/>", () => {
		const body = `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:">
  <d:allprop/>
</d:propfind>`;
		expect(parsePropFilter(body)).toBe("allprop");
	});

	it("parses specific properties from <d:prop>", () => {
		const body = `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <d:getetag/>
  </d:prop>
</d:propfind>`;
		const filter = parsePropFilter(body);
		expect(filter).not.toBe("allprop");
		expect(filter).toBeInstanceOf(Set);
		const props = filter as Set<string>;
		expect(props.has("displayname")).toBe(true);
		expect(props.has("resourcetype")).toBe(true);
		expect(props.has("getetag")).toBe(true);
		expect(props.has("getcontenttype")).toBe(false);
	});

	it("handles namespaced property tags", () => {
		const body = `<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <c:calendar-home-set/>
    <d:current-user-principal/>
  </d:prop>
</d:propfind>`;
		const filter = parsePropFilter(body) as Set<string>;
		expect(filter.has("calendar-home-set")).toBe(true);
		expect(filter.has("current-user-principal")).toBe(true);
	});

	it("returns allprop when no <prop> block found", () => {
		const body = `<d:propfind xmlns:d="DAV:">
  <d:something-else/>
</d:propfind>`;
		expect(parsePropFilter(body)).toBe("allprop");
	});

	it("handles self-closing allprop without namespace", () => {
		const body = `<propfind><allprop/></propfind>`;
		expect(parsePropFilter(body)).toBe("allprop");
	});
});

describe("getDepthHeader", () => {
	it("returns '0' for undefined", () => {
		expect(getDepthHeader(undefined)).toBe("0");
	});

	it("returns '0' for '0'", () => {
		expect(getDepthHeader("0")).toBe("0");
	});

	it("returns '1' for '1'", () => {
		expect(getDepthHeader("1")).toBe("1");
	});

	it("returns '0' for 'infinity' (implementation only checks for char '1')", () => {
		// Note: RFC 4918 defines Depth: infinity, but CalDAV clients
		// rarely use it. Current implementation treats it as "0".
		expect(getDepthHeader("infinity")).toBe("0");
	});

	it("returns '0' for empty string", () => {
		expect(getDepthHeader("")).toBe("0");
	});
});

describe("calendarCollectionProps", () => {
	const cal: Calendar = {
		id: 1,
		userId: "user1",
		name: "My Calendar",
		componentType: "VTODO",
		synctoken: 5,
		ctag: "ctag-5",
		color: "#FF0000",
		calendarOrder: 2,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-03-01T00:00:00Z",
	};

	it("includes displayname", () => {
		const xml = calendarCollectionProps(cal);
		expect(xml).toContain("<d:displayname>My Calendar</d:displayname>");
	});

	it("includes resourcetype with calendar", () => {
		const xml = calendarCollectionProps(cal);
		expect(xml).toContain("<d:collection/><c:calendar/>");
	});

	it("includes sync-token", () => {
		const xml = calendarCollectionProps(cal);
		expect(xml).toContain("<d:sync-token>5</d:sync-token>");
	});

	it("includes ctag", () => {
		const xml = calendarCollectionProps(cal);
		expect(xml).toContain("getctag");
		expect(xml).toContain("ctag-5");
	});

	it("includes calendar-color", () => {
		const xml = calendarCollectionProps(cal);
		expect(xml).toContain("<ical:calendar-color>#FF0000</ical:calendar-color>");
	});

	it("includes calendar-order", () => {
		const xml = calendarCollectionProps(cal);
		expect(xml).toContain("<ical:calendar-order>2</ical:calendar-order>");
	});

	it("includes supported-calendar-component-set", () => {
		const xml = calendarCollectionProps(cal);
		expect(xml).toContain('comp name="VTODO"');
	});

	it("respects prop filter", () => {
		const filter = new Set(["displayname"]);
		const xml = calendarCollectionProps(cal, filter);
		expect(xml).toContain("displayname");
		expect(xml).not.toContain("resourcetype");
		expect(xml).not.toContain("sync-token");
		expect(xml).not.toContain("calendar-color");
	});

	it("escapes XML special characters in name", () => {
		const calWithSpecial = { ...cal, name: "Cal <&>" };
		const xml = calendarCollectionProps(calWithSpecial);
		expect(xml).toContain("Cal &lt;&amp;&gt;");
		expect(xml).not.toContain("Cal <&>");
	});

	it("omits color when null", () => {
		const calNoColor = { ...cal, color: null };
		const xml = calendarCollectionProps(calNoColor);
		expect(xml).not.toContain("calendar-color");
	});

	it("omits calendarOrder when null", () => {
		const calNoOrder = { ...cal, calendarOrder: null };
		const xml = calendarCollectionProps(calNoOrder);
		expect(xml).not.toContain("calendar-order");
	});
});
