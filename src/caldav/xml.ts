import type { Context } from "hono";

import type { CaldavUser } from "../auth/caldav-token.js";
import type { Calendar, CalendarObject } from "./storage.js";

const CALDAV_NS = "urn:ietf:params:xml:ns:caldav";
const DAV_HEADERS = {
	DAV: "1, calendar-access",
};

export type PropFilter = Set<string> | "allprop";

export function parsePropFilter(body: string): PropFilter {
	if (!body.trim()) return "allprop";
	if (/<(?:[^:>]+:)?allprop\s*\/?>/i.test(body)) return "allprop";

	// Match <d:prop>...</d:prop> or <prop>...</prop>
	const propBlockMatch = body.match(
		/<(?:[^:>]+:)?prop\b[^>]*>([\s\S]*?)<\/(?:[^:>]+:)?prop>/i,
	);
	if (!propBlockMatch) return "allprop";

	const propBlock = propBlockMatch[1];
	const props = new Set<string>();
	// Extract local names from self-closing or opening tags inside <d:prop>
	const tagRegex = /<(?:[^:>]+:)?(\S+?)[\s/>]/g;
	let m: RegExpExecArray | null;
	while ((m = tagRegex.exec(propBlock)) !== null) {
		const name = m[1].toLowerCase();
		if (name && !name.startsWith("/")) {
			props.add(name);
		}
	}
	return props.size > 0 ? props : "allprop";
}

function shouldInclude(filter: PropFilter, propName: string): boolean {
	if (filter === "allprop") return true;
	return filter.has(propName);
}

function xmlEscape(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function href(path: string): string {
	const normalized = path.startsWith("/") ? path : `/${path}`;
	if (normalized.endsWith("/") || normalized.endsWith(".ics")) {
		return normalized;
	}
	return `${normalized}/`;
}

function propstatOk(props: string): string {
	return `
    <d:propstat>
      <d:prop>
${props}
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>`;
}

function responseFor(hrefValue: string, props: string): string {
	return `
  <d:response>
    <d:href>${xmlEscape(hrefValue)}</d:href>${propstatOk(props)}
  </d:response>`;
}

function responseNotFound(hrefValue: string): string {
	return `
  <d:response>
    <d:href>${xmlEscape(hrefValue)}</d:href>
    <d:status>HTTP/1.1 404 Not Found</d:status>
  </d:response>`;
}

function responseGone(hrefValue: string): string {
	return `
  <d:response>
    <d:href>${xmlEscape(hrefValue)}</d:href>
    <d:status>HTTP/1.1 410 Gone</d:status>
  </d:response>`;
}

function multistatus(responses: string, syncToken?: string): string {
	const token = syncToken
		? `
  <d:sync-token>${xmlEscape(syncToken)}</d:sync-token>`
		: "";
	return `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="${CALDAV_NS}" xmlns:cs="http://calendarserver.org/ns/" xmlns:ical="http://apple.com/ns/ical/">
${token}
${responses}
</d:multistatus>`;
}

function collectionProps(
	displayName: string,
	resType: string,
	extra: string = "",
	ctag?: string,
	filter: PropFilter = "allprop",
): string {
	let result = "";
	if (shouldInclude(filter, "displayname")) {
		result += `
        <d:displayname>${xmlEscape(displayName)}</d:displayname>`;
	}
	if (shouldInclude(filter, "resourcetype")) {
		result += `
        <d:resourcetype>${resType}</d:resourcetype>`;
	}
	if (ctag && shouldInclude(filter, "getctag")) {
		result += `
        <cs:getctag xmlns:cs="http://calendarserver.org/ns/">${xmlEscape(ctag)}</cs:getctag>`;
	}
	if (extra) {
		result += `
        ${extra}`;
	}
	return result.trimEnd();
}

function objectProps(
	obj: CalendarObject,
	componentType: string,
	filter: PropFilter = "allprop",
): string {
	let result = "";
	if (shouldInclude(filter, "getetag")) {
		result += `
        <d:getetag>${xmlEscape(obj.etag)}</d:getetag>`;
	}
	if (shouldInclude(filter, "getcontenttype")) {
		result += `
        <d:getcontenttype>text/calendar; charset=utf-8; component=${componentType}</d:getcontenttype>`;
	}
	if (shouldInclude(filter, "getcontentlength")) {
		result += `
        <d:getcontentlength>${obj.icsData.length}</d:getcontentlength>`;
	}
	if (shouldInclude(filter, "getlastmodified")) {
		result += `
        <d:getlastmodified>${new Date(obj.updatedAt).toUTCString()}</d:getlastmodified>`;
	}
	return result;
}

function calendarCollectionExtra(
	componentType: string,
	color: string | null,
	calendarOrder: number | null,
	filter: PropFilter = "allprop",
): string {
	let result = "";
	if (shouldInclude(filter, "supported-calendar-component-set")) {
		result += `
        <c:supported-calendar-component-set>
          <c:comp name="${componentType}"/>
        </c:supported-calendar-component-set>`;
	}
	if (shouldInclude(filter, "supported-report-set")) {
		result += `
        <d:supported-report-set>
          <d:supported-report><d:report><c:calendar-query/></d:report></d:supported-report>
          <d:supported-report><d:report><c:calendar-multiget/></d:report></d:supported-report>
          <d:supported-report><d:report><d:sync-collection/></d:report></d:supported-report>
        </d:supported-report-set>`;
	}
	if (shouldInclude(filter, "current-user-privilege-set")) {
		result += `
        <d:current-user-privilege-set>
          <d:privilege><d:read/></d:privilege>
          <d:privilege><d:write/></d:privilege>
          <d:privilege><d:write-content/></d:privilege>
          <d:privilege><d:bind/></d:privilege>
          <d:privilege><d:unbind/></d:privilege>
        </d:current-user-privilege-set>`;
	}
	if (color && shouldInclude(filter, "calendar-color")) {
		result += `
        <ical:calendar-color>${xmlEscape(color)}</ical:calendar-color>`;
	}
	if (calendarOrder != null && shouldInclude(filter, "calendar-order")) {
		result += `
        <ical:calendar-order>${calendarOrder}</ical:calendar-order>`;
	}
	return result;
}

export function getDepthHeader(depthHeader?: string): "0" | "1" {
	if (!depthHeader) {
		return "0";
	}
	return depthHeader.includes("1") ? "1" : "0";
}

export function buildUnauthorizedResponse(c: Context) {
	return c.text("Unauthorized", 401, {
		"WWW-Authenticate": 'Basic realm="CalDAV"',
	});
}

export function buildEntryResponse(
	c: Context,
	user: CaldavUser,
	filter: PropFilter = "allprop",
) {
	const extra = shouldInclude(filter, "current-user-principal")
		? `
        <d:current-user-principal>
          <d:href>${href(`/dav/principals/${user.username}`)}</d:href>
        </d:current-user-principal>`
		: "";
	const props = collectionProps("CalDAV", "<d:collection/>", extra, undefined, filter);
	return c.body(multistatus(responseFor(href("/dav/"), props)), 207, {
		...DAV_HEADERS,
		"Content-Type": "application/xml; charset=utf-8",
	});
}

export function buildPrincipalResponse(
	c: Context,
	user: CaldavUser,
	filter: PropFilter = "allprop",
) {
	let extra = "";
	if (shouldInclude(filter, "calendar-home-set")) {
		extra += `
        <c:calendar-home-set>
          <d:href>${href("/dav/projects/")}</d:href>
        </c:calendar-home-set>`;
	}
	if (shouldInclude(filter, "current-user-principal")) {
		extra += `
        <d:current-user-principal>
          <d:href>${href(`/dav/principals/${user.username}`)}</d:href>
        </d:current-user-principal>`;
	}
	const props = collectionProps(
		user.displayName ?? user.username,
		"<d:collection/><d:principal/>",
		extra,
		undefined,
		filter,
	);
	return c.body(
		multistatus(responseFor(href(`/dav/principals/${user.username}`), props)),
		207,
		{
			...DAV_HEADERS,
			"Content-Type": "application/xml; charset=utf-8",
		},
	);
}

export function buildCalendarCollectionResponse(
	c: Context,
	user: CaldavUser,
	calendars: Calendar[],
	depth: "0" | "1",
	filter: PropFilter = "allprop",
) {
	let extra = "";
	if (shouldInclude(filter, "supported-calendar-component-set")) {
		extra += `
        <c:supported-calendar-component-set>
          <c:comp name="VTODO"/>
          <c:comp name="VEVENT"/>
        </c:supported-calendar-component-set>`;
	}
	if (shouldInclude(filter, "current-user-privilege-set")) {
		extra += `
        <d:current-user-privilege-set>
          <d:privilege><d:read/></d:privilege>
          <d:privilege><d:write/></d:privilege>
          <d:privilege><d:bind/></d:privilege>
          <d:privilege><d:unbind/></d:privilege>
        </d:current-user-privilege-set>`;
	}
	let responses = responseFor(
		href("/dav/projects/"),
		collectionProps(
			`${user.username} Calendars`,
			"<d:collection/>",
			extra,
			undefined,
			filter,
		),
	);

	if (depth === "1") {
		for (const cal of calendars) {
			responses += responseFor(
				href(`/dav/projects/${cal.id}`),
				calendarCollectionProps(cal, filter),
			);
		}
	}

	return c.body(multistatus(responses), 207, {
		...DAV_HEADERS,
		"Content-Type": "application/xml; charset=utf-8",
	});
}

export function calendarCollectionProps(
	cal: Calendar,
	filter: PropFilter = "allprop",
): string {
	return collectionProps(
		cal.name,
		"<d:collection/><c:calendar/>",
		calendarCollectionExtra(cal.componentType, cal.color, cal.calendarOrder, filter),
		cal.ctag,
		filter,
	);
}

export function buildCalendarResponse(
	c: Context,
	cal: Calendar,
	filter: PropFilter = "allprop",
) {
	const props = calendarCollectionProps(cal, filter);
	return c.body(
		multistatus(responseFor(href(`/dav/projects/${cal.id}`), props)),
		207,
		{
			...DAV_HEADERS,
			"Content-Type": "application/xml; charset=utf-8",
		},
	);
}

export function buildCalendarWithObjectsResponse(
	c: Context,
	cal: Calendar,
	objects: CalendarObject[],
	filter: PropFilter = "allprop",
) {
	let responses = responseFor(
		href(`/dav/projects/${cal.id}`),
		calendarCollectionProps(cal, filter),
	);
	for (const obj of objects) {
		responses += responseFor(
			href(`/dav/projects/${cal.id}/${obj.uid}.ics`),
			objectProps(obj, cal.componentType, filter),
		);
	}
	return c.body(multistatus(responses), 207, {
		...DAV_HEADERS,
		"Content-Type": "application/xml; charset=utf-8",
	});
}

export function buildObjectResponse(
	c: Context,
	cal: Calendar,
	obj: CalendarObject,
	filter: PropFilter = "allprop",
) {
	const props = objectProps(obj, cal.componentType, filter);
	return c.body(
		multistatus(
			responseFor(href(`/dav/projects/${cal.id}/${obj.uid}.ics`), props),
		),
		207,
		{
			...DAV_HEADERS,
			"Content-Type": "application/xml; charset=utf-8",
		},
	);
}

export function buildPropPatchResponse(
	c: Context,
	hrefValue: string,
	props?: string,
) {
	return c.body(multistatus(responseFor(hrefValue, props ?? "")), 207, {
		...DAV_HEADERS,
		"Content-Type": "application/xml; charset=utf-8",
	});
}

export function buildCalendarQueryResponse(
	c: Context,
	cal: Calendar,
	objects: CalendarObject[],
	withCalendarData: boolean,
	syncToken?: string,
) {
	let responses = "";
	for (const obj of objects) {
		const extra = withCalendarData
			? `
        <c:calendar-data>${xmlEscape(obj.icsData)}</c:calendar-data>`
			: "";
		responses += responseFor(
			href(`/dav/projects/${cal.id}/${obj.uid}.ics`),
			objectProps(obj, cal.componentType) + extra,
		);
	}
	return c.body(multistatus(responses, syncToken), 207, {
		...DAV_HEADERS,
		"Content-Type": "application/xml; charset=utf-8",
	});
}

export function buildSyncCollectionResponse(
	c: Context,
	cal: Calendar,
	objects: CalendarObject[],
	deletedUris: string[],
	withCalendarData: boolean,
	syncToken?: string,
) {
	let responses = "";
	for (const obj of objects) {
		const extra = withCalendarData
			? `
        <c:calendar-data>${xmlEscape(obj.icsData)}</c:calendar-data>`
			: "";
		responses += responseFor(
			href(`/dav/projects/${cal.id}/${obj.uid}.ics`),
			objectProps(obj, cal.componentType) + extra,
		);
	}
	for (const uri of deletedUris) {
		const uid = uri.replace(/\.ics$/i, "");
		responses += responseGone(href(`/dav/projects/${cal.id}/${uid}.ics`));
	}
	return c.body(multistatus(responses, syncToken), 207, {
		...DAV_HEADERS,
		"Content-Type": "application/xml; charset=utf-8",
	});
}

export function buildCalendarMultigetResponse(
	c: Context,
	cal: Calendar,
	objects: CalendarObject[],
	deletedUris: string[],
	body: string,
	withCalendarData: boolean,
	syncToken?: string,
) {
	const hrefs = Array.from(
		body.matchAll(/<(?:[^:>]+:)?href\b[^>]*>([^<]+)<\/(?:[^:>]+:)?href>/g),
		(match) => match[1],
	);
	const objectMap = new Map(objects.map((obj) => [obj.uid.toUpperCase(), obj]));
	const deletedSet = new Set(
		deletedUris.map((uri) => uri.replace(/\.ics$/i, "").toUpperCase()),
	);
	let responses = "";
	for (const hrefValue of hrefs) {
		let path = hrefValue;
		if (hrefValue.startsWith("http://") || hrefValue.startsWith("https://")) {
			try {
				path = new URL(hrefValue).pathname;
			} catch {
				path = hrefValue;
			}
		}
		const rawLast = path.split("/").pop();
		let uid = "";
		if (rawLast) {
			try {
				uid = decodeURIComponent(rawLast).replace(/\.ics$/i, "");
			} catch {
				uid = "";
			}
		}
		if (!uid) {
			continue;
		}
		const obj = objectMap.get(uid.toUpperCase());
		if (!obj) {
			responses += deletedSet.has(uid.toUpperCase())
				? responseGone(hrefValue)
				: responseNotFound(hrefValue);
			continue;
		}
		const extra = withCalendarData
			? `
        <c:calendar-data>${xmlEscape(obj.icsData)}</c:calendar-data>`
			: "";
		responses += responseFor(
			hrefValue,
			objectProps(obj, cal.componentType) + extra,
		);
	}
	return c.body(multistatus(responses, syncToken), 207, {
		...DAV_HEADERS,
		"Content-Type": "application/xml; charset=utf-8",
	});
}
