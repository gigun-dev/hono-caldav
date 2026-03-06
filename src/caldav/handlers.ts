import type { Context, Hono } from "hono";
import { decodeBase64 } from "hono/utils/encode";

import {
	type CaldavUser,
	authenticateBasicUser,
} from "../auth/caldav-token.js";
import { isValidComponent } from "./ical.js";
import {
	createCalendar,
	deleteObject,
	getCalendarById,
	getCalendarsForUser,
	getChangesSince,
	getObjectByUid,
	getObjectsForCalendar,
	putObject,
	updateCalendarColor,
	updateCalendarDisplayName,
	updateCalendarOrder,
} from "./storage.js";
import {
	buildCalendarCollectionResponse,
	buildCalendarMultigetResponse,
	buildCalendarQueryResponse,
	buildCalendarResponse,
	buildCalendarWithObjectsResponse,
	buildEntryResponse,
	buildObjectResponse,
	buildPrincipalResponse,
	buildPropPatchResponse,
	buildSyncCollectionResponse,
	buildUnauthorizedResponse,
	calendarCollectionProps,
	getDepthHeader,
	parsePropFilter,
} from "./xml.js";

const MAX_BODY_SIZE = 256 * 1024; // 256KB

async function readBodyWithLimit(
	c: Context<{ Bindings: CloudflareBindings }>,
): Promise<{ body: string } | { error: Response }> {
	const contentLength = c.req.header("content-length");
	if (contentLength) {
		const len = parseInt(contentLength, 10);
		if (Number.isNaN(len) || len > MAX_BODY_SIZE) {
			return { error: c.text("Request Entity Too Large", 413) };
		}
	}
	const body = await c.req.text();
	if (body.length > MAX_BODY_SIZE) {
		return { error: c.text("Request Entity Too Large", 413) };
	}
	return { body };
}

const DAV_HEADERS = {
	DAV: "1, calendar-access, sync-collection, extended-mkcol",
	Allow: "OPTIONS, PROPFIND, REPORT, GET, PUT, DELETE, PROPPATCH, MKCOL",
};

function parseProppatchDisplayName(body: string): string | null {
	const m = body.match(
		/<(?:[^:>]+:)?displayname[^>]*>([^<]*)<\/(?:[^:>]+:)?displayname>/i,
	);
	if (!m || m[1] === undefined) {
		return null;
	}
	const value = m[1].trim();
	return value === "" ? null : value;
}

function parseProppatchCalendarColor(body: string): string | null {
	const m = body.match(
		/<(?:[^:>]+:)?calendar-color[^>]*>([^<]*)<\/(?:[^:>]+:)?calendar-color>/i,
	);
	if (!m || m[1] === undefined) {
		return null;
	}
	const value = m[1].trim();
	return value === "" ? null : value;
}

function parseProppatchCalendarOrder(body: string): number | null {
	const m = body.match(
		/<(?:[^:>]+:)?calendar-order[^>]*>([^<]*)<\/(?:[^:>]+:)?calendar-order>/i,
	);
	if (!m || m[1] === undefined) {
		return null;
	}
	const value = m[1].trim();
	if (value === "") {
		return null;
	}
	const num = parseInt(value, 10);
	return Number.isNaN(num) ? null : num;
}

function parseMkcalendarBody(body: string): {
	displayName: string | null;
	componentType: string | null;
	color: string | null;
	order: number | null;
} {
	const displayNameMatch = body.match(
		/<(?:[^:>]+:)?displayname[^>]*>([^<]*)<\/(?:[^:>]+:)?displayname>/i,
	);
	const displayName = displayNameMatch?.[1]?.trim() || null;

	const compMatch = body.match(/<(?:[^:>]+:)?comp\s+name="([^"]+)"/i);
	const componentType = compMatch?.[1]?.toUpperCase() || "VTODO";

	const color = parseProppatchCalendarColor(body);
	const order = parseProppatchCalendarOrder(body);

	return { displayName, componentType, color, order };
}

function parseMkcolBody(body: string): {
	displayName: string | null;
	componentType: string | null;
	color: string | null;
	order: number | null;
} {
	const displayNameMatch = body.match(
		/<(?:[^:>]+:)?displayname[^>]*>([^<]*)<\/(?:[^:>]+:)?displayname>/i,
	);
	const displayName = displayNameMatch?.[1]?.trim() || null;

	// Extended MKCOL: check resourcetype for <c:calendar/> or <C:calendar/>
	const isCalendar =
		/<(?:[^:>]+:)?calendar\s*\/>/i.test(body) &&
		/<(?:[^:>]+:)?collection\s*\/>/i.test(body);

	// Component type from supported-calendar-component-set or comp name
	const compMatch = body.match(/<(?:[^:>]+:)?comp\s+name="([^"]+)"/i);
	let componentType = compMatch?.[1]?.toUpperCase() || null;

	// If it's a calendar resourcetype but no component specified, default to VEVENT
	if (isCalendar && !componentType) {
		componentType = "VEVENT";
	}

	const color = parseProppatchCalendarColor(body);
	const order = parseProppatchCalendarOrder(body);

	return { displayName, componentType, color, order };
}

function parseBasicAuth(header: string | undefined): {
	username: string;
	password: string;
} | null {
	if (!header) {
		return null;
	}
	const [scheme, value] = header.split(" ");
	if (!scheme || scheme.toLowerCase() !== "basic" || !value) {
		return null;
	}
	const decoded = new TextDecoder().decode(decodeBase64(value));
	const idx = decoded.indexOf(":");
	if (idx === -1) {
		return null;
	}
	return {
		username: decoded.slice(0, idx),
		password: decoded.slice(idx + 1),
	};
}

function normalizeUidParam(rawValue: string): string | null {
	const uid = decodeURIComponent(rawValue).replace(/\.ics$/i, "");
	return uid || null;
}

function requireAuth(
	c: Context<{ Bindings: CloudflareBindings }>,
): CaldavUser | null {
	const auth = parseBasicAuth(c.req.header("authorization"));
	if (!auth) {
		return null;
	}
	return authenticateBasicUser(c.env, auth.username, auth.password);
}

export function registerCaldavRoutes(
	app: Hono<{ Bindings: CloudflareBindings }>,
) {
	app.on("OPTIONS", "/", (c) => c.body(null, 204, DAV_HEADERS));
	app.on("OPTIONS", "/dav/*", (c) => c.body(null, 204, DAV_HEADERS));

	app.on("OPTIONS", "/.well-known/caldav", (c) =>
		c.body(null, 204, DAV_HEADERS),
	);

	app.get("/.well-known/caldav", (c) => c.redirect("/dav/", 301));

	const handlePrincipal = async (
		c: Context<{ Bindings: CloudflareBindings }>,
	) => {
		const user = requireAuth(c);
		if (!user) {
			return buildUnauthorizedResponse(c);
		}
		const read = await readBodyWithLimit(c);
		const filter = parsePropFilter("error" in read ? "" : read.body);
		return buildPrincipalResponse(c, user, filter);
	};

	const handleEntry = async (c: Context<{ Bindings: CloudflareBindings }>) => {
		const user = requireAuth(c);
		if (!user) {
			return buildUnauthorizedResponse(c);
		}
		const read = await readBodyWithLimit(c);
		const filter = parsePropFilter("error" in read ? "" : read.body);
		return buildEntryResponse(c, user, filter);
	};

	const handleProjects = async (
		c: Context<{ Bindings: CloudflareBindings }>,
	) => {
		const user = requireAuth(c);
		if (!user) {
			return buildUnauthorizedResponse(c);
		}
		const depth = getDepthHeader(c.req.header("depth"));
		const read = await readBodyWithLimit(c);
		const filter = parsePropFilter("error" in read ? "" : read.body);
		const calendars = await getCalendarsForUser(c.env.DB, user.id);
		return buildCalendarCollectionResponse(c, user, calendars, depth, filter);
	};

	const handleProject = async (
		c: Context<{ Bindings: CloudflareBindings }>,
	) => {
		const user = requireAuth(c);
		if (!user) {
			return buildUnauthorizedResponse(c);
		}
		const depth = getDepthHeader(c.req.header("depth"));
		const read = await readBodyWithLimit(c);
		const filter = parsePropFilter("error" in read ? "" : read.body);
		const cal = await getCalendarById(
			c.env.DB,
			user.id,
			Number(c.req.param("projectId")),
		);
		if (!cal) {
			return c.text("Calendar not found", 404);
		}
		if (depth === "1") {
			const objects = await getObjectsForCalendar(c.env.DB, cal.id);
			return buildCalendarWithObjectsResponse(c, cal, objects, filter);
		}
		return buildCalendarResponse(c, cal, filter);
	};

	const handleReport = async (c: Context<{ Bindings: CloudflareBindings }>) => {
		const user = requireAuth(c);
		if (!user) {
			return buildUnauthorizedResponse(c);
		}
		const read = await readBodyWithLimit(c);
		if ("error" in read) {
			return read.error;
		}
		const body = read.body;
		const isSyncCollection = body.includes("sync-collection");
		const isMultiget = body.includes("calendar-multiget");
		const syncTokenMatch =
			body.match(/<d:sync-token>([^<]+)<\/d:sync-token>/i) ??
			body.match(/<sync-token>([^<]+)<\/sync-token>/i);
		const requestSyncToken = syncTokenMatch?.[1];

		const cal = await getCalendarById(
			c.env.DB,
			user.id,
			Number(c.req.param("projectId")),
		);
		if (!cal) {
			return c.text("Calendar not found", 404);
		}

		const currentSyncToken = String(cal.synctoken);

		if (isSyncCollection) {
			const clientToken = requestSyncToken ? Number(requestSyncToken) : 0;

			if (clientToken > 0) {
				// Incremental sync via calendarchanges
				const changes = await getChangesSince(c.env.DB, cal.id, clientToken);

				// Deduplicate: keep only the latest operation per URI
				const latestByUri = new Map<
					string,
					{ uri: string; operation: number }
				>();
				for (const change of changes) {
					latestByUri.set(change.uri, {
						uri: change.uri,
						operation: change.operation,
					});
				}

				const addedOrModifiedUids: string[] = [];
				const deletedUris: string[] = [];
				for (const entry of latestByUri.values()) {
					if (entry.operation === 3) {
						deletedUris.push(entry.uri);
					} else {
						const uid = entry.uri.replace(/\.ics$/i, "");
						addedOrModifiedUids.push(uid);
					}
				}

				// Fetch current objects for added/modified
				const objects = [];
				for (const uid of addedOrModifiedUids) {
					const obj = await getObjectByUid(c.env.DB, cal.id, uid);
					if (obj) objects.push(obj);
				}

				return buildSyncCollectionResponse(
					c,
					cal,
					objects,
					deletedUris,
					true,
					currentSyncToken,
				);
			}

			// Full sync (no token or token=0)
			const objects = await getObjectsForCalendar(c.env.DB, cal.id);
			return buildSyncCollectionResponse(
				c,
				cal,
				objects,
				[],
				true,
				currentSyncToken,
			);
		}

		const objects = await getObjectsForCalendar(c.env.DB, cal.id);

		if (isMultiget) {
			// Collect deleted URIs from calendarchanges (operation=3)
			const allChanges = await getChangesSince(c.env.DB, cal.id, 0);
			const deletedUris = [
				...new Set(
					allChanges.filter((ch) => ch.operation === 3).map((ch) => ch.uri),
				),
			];

			return buildCalendarMultigetResponse(
				c,
				cal,
				objects,
				deletedUris,
				body,
				true,
				currentSyncToken,
			);
		}

		return buildCalendarQueryResponse(c, cal, objects, true, currentSyncToken);
	};

	const handleProjectPropPatch = async (
		c: Context<{ Bindings: CloudflareBindings }>,
	) => {
		const user = requireAuth(c);
		if (!user) {
			return buildUnauthorizedResponse(c);
		}
		const read = await readBodyWithLimit(c);
		if ("error" in read) {
			return read.error;
		}
		const calendarId = Number(c.req.param("projectId"));
		const hrefValue = `/dav/projects/${calendarId}/`;

		const displayName = parseProppatchDisplayName(read.body);
		const color = parseProppatchCalendarColor(read.body);
		const order = parseProppatchCalendarOrder(read.body);

		let cal = await getCalendarById(c.env.DB, user.id, calendarId);
		if (!cal) {
			return c.text("Calendar not found", 404);
		}

		if (displayName !== null) {
			cal = await updateCalendarDisplayName(
				c.env.DB,
				user.id,
				calendarId,
				displayName,
			);
		}
		if (color !== null) {
			cal = await updateCalendarColor(
				c.env.DB,
				user.id,
				calendarId,
				color,
			);
		}
		if (order !== null) {
			cal = await updateCalendarOrder(
				c.env.DB,
				user.id,
				calendarId,
				order,
			);
		}

		return buildPropPatchResponse(
			c,
			hrefValue,
			calendarCollectionProps(cal!),
		);
	};

	// Shared calendar creation logic for MKCOL and MKCALENDAR
	const handleCreateCalendar = async (
		c: Context<{ Bindings: CloudflareBindings }>,
		parseBody: (body: string) => {
			displayName: string | null;
			componentType: string | null;
			color: string | null;
			order: number | null;
		},
	) => {
		const user = requireAuth(c);
		if (!user) {
			return buildUnauthorizedResponse(c);
		}
		const read = await readBodyWithLimit(c);
		if ("error" in read) {
			return read.error;
		}
		const { displayName, componentType, color, order } = parseBody(read.body);
		if (!componentType || !["VTODO", "VEVENT"].includes(componentType)) {
			return c.text("Invalid or missing component type", 400);
		}
		const name = displayName || "Untitled";
		const cal = await createCalendar(
			c.env.DB,
			user.id,
			name,
			componentType,
			color,
			order,
		);
		return c.body(null, 201, {
			Location: `/dav/projects/${cal.id}/`,
		});
	};

	const handleMkcol = (c: Context<{ Bindings: CloudflareBindings }>) =>
		handleCreateCalendar(c, parseMkcolBody);

	const handleMkcalendar = (c: Context<{ Bindings: CloudflareBindings }>) =>
		handleCreateCalendar(c, parseMkcalendarBody);

	app.on("PROPFIND", "/", handleEntry);

	app.on("PROPFIND", "/.well-known/caldav", (c) => c.redirect("/dav/", 301));

	app.on("PROPFIND", "/dav", handleEntry);
	app.on("PROPFIND", "/dav/", handleEntry);

	app.on("PROPFIND", "/dav/principals/:username", handlePrincipal);
	app.on("PROPFIND", "/dav/principals/:username/", handlePrincipal);

	app.on("PROPFIND", "/dav/projects", handleProjects);
	app.on("PROPFIND", "/dav/projects/", handleProjects);

	app.on("PROPFIND", "/dav/projects/:projectId", handleProject);
	app.on("PROPFIND", "/dav/projects/:projectId/", handleProject);

	app.on("REPORT", "/dav/projects/:projectId", handleReport);
	app.on("REPORT", "/dav/projects/:projectId/", handleReport);

	app.on("PROPPATCH", "/dav/projects/:projectId", handleProjectPropPatch);
	app.on("PROPPATCH", "/dav/projects/:projectId/", handleProjectPropPatch);

	app.on("MKCOL", "/dav/projects/", handleMkcol);
	app.on("MKCOL", "/dav/projects/:slug", handleMkcol);
	app.on("MKCOL", "/dav/projects/:slug/", handleMkcol);

	// MKCALENDAR: workerd は非標準メソッドを受け付けないため、
	// proxy が POST + X-Caldav-Method: MKCALENDAR に書き換えて送ってくる
	const handleMkcalendarProxy = (
		c: Context<{ Bindings: CloudflareBindings }>,
	) => {
		if (c.req.header("x-caldav-method")?.toUpperCase() !== "MKCALENDAR") {
			return c.text("Method Not Allowed", 405);
		}
		return handleMkcalendar(c);
	};
	app.post("/dav/projects/", handleMkcalendarProxy);
	app.post("/dav/projects/:slug", handleMkcalendarProxy);
	app.post("/dav/projects/:slug/", handleMkcalendarProxy);

	// GET single object
	app.get("/dav/projects/:projectId/:uid", async (c) => {
		const user = requireAuth(c);
		if (!user) {
			return buildUnauthorizedResponse(c);
		}
		const cal = await getCalendarById(
			c.env.DB,
			user.id,
			Number(c.req.param("projectId")),
		);
		if (!cal) {
			return c.text("Calendar not found", 404);
		}
		const uid = normalizeUidParam(c.req.param("uid"));
		if (!uid) {
			return c.text("Object not found", 404);
		}
		const obj = await getObjectByUid(c.env.DB, cal.id, uid);
		if (!obj) {
			return c.text("Object not found", 404);
		}
		return c.text(obj.icsData, 200, {
			ETag: obj.etag,
			"Content-Type": "text/calendar; charset=utf-8",
		});
	});

	// PROPFIND single object
	app.on("PROPFIND", "/dav/projects/:projectId/:uid", async (c) => {
		const user = requireAuth(c);
		if (!user) {
			return buildUnauthorizedResponse(c);
		}
		const read = await readBodyWithLimit(c);
		const filter = parsePropFilter("error" in read ? "" : read.body);
		const cal = await getCalendarById(
			c.env.DB,
			user.id,
			Number(c.req.param("projectId")),
		);
		if (!cal) {
			return c.text("Calendar not found", 404);
		}
		const uid = normalizeUidParam(c.req.param("uid"));
		if (!uid) {
			return c.text("Object not found", 404);
		}
		const obj = await getObjectByUid(c.env.DB, cal.id, uid);
		if (!obj) {
			return c.text("Object not found", 404);
		}
		return buildObjectResponse(c, cal, obj, filter);
	});

	// PUT (create or update) object
	app.put("/dav/projects/:projectId/:uid", async (c) => {
		const user = requireAuth(c);
		if (!user) {
			return buildUnauthorizedResponse(c);
		}
		const read = await readBodyWithLimit(c);
		if ("error" in read) {
			return read.error;
		}
		const icsData = read.body;

		const cal = await getCalendarById(
			c.env.DB,
			user.id,
			Number(c.req.param("projectId")),
		);
		if (!cal) {
			return c.text("Calendar not found", 404);
		}

		if (!isValidComponent(icsData, cal.componentType)) {
			return c.text(`Invalid ${cal.componentType}`, 400);
		}

		const uid = normalizeUidParam(c.req.param("uid"));
		if (!uid) {
			return c.text("Invalid UID", 400);
		}

		// If-Match check
		const ifMatch = c.req.header("if-match");
		if (ifMatch) {
			const existing = await getObjectByUid(c.env.DB, cal.id, uid);
			if (ifMatch === "*") {
				if (!existing) {
					return c.text("Precondition Failed", 412);
				}
			} else if (existing && existing.etag !== ifMatch) {
				return c.text("Precondition Failed", 412);
			}
		}

		const { object, created } = await putObject(c.env.DB, cal.id, uid, icsData);

		return c.text(object.icsData, created ? 201 : 200, {
			ETag: object.etag,
			"Content-Type": "text/calendar; charset=utf-8",
		});
	});

	// DELETE object
	app.delete("/dav/projects/:projectId/:uid", async (c) => {
		const user = requireAuth(c);
		if (!user) {
			return buildUnauthorizedResponse(c);
		}
		const cal = await getCalendarById(
			c.env.DB,
			user.id,
			Number(c.req.param("projectId")),
		);
		if (!cal) {
			return c.text("Calendar not found", 404);
		}
		const uid = normalizeUidParam(c.req.param("uid"));
		if (!uid) {
			return c.text("Object not found", 404);
		}

		// If-Match check
		const ifMatch = c.req.header("if-match");
		if (ifMatch) {
			const existing = await getObjectByUid(c.env.DB, cal.id, uid);
			if (ifMatch === "*") {
				if (!existing) {
					return c.text("Precondition Failed", 412);
				}
			} else {
				if (!existing || existing.etag !== ifMatch) {
					return c.text("Precondition Failed", 412);
				}
			}
		}

		const deleted = await deleteObject(c.env.DB, cal.id, uid);
		if (!deleted) {
			return c.text("Object not found", 404);
		}
		return c.body(null, 204);
	});
}
