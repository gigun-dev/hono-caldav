import type { MiddlewareHandler } from "hono";
import { decodeBase64 } from "hono/utils/encode";

import type { AppBindings } from "../types.js";
import { verifyAppPassword } from "../auth/app-password.js";

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

export const caldavAuth: MiddlewareHandler<AppBindings> = async (c, next) => {
	const creds = parseBasicAuth(c.req.header("authorization"));
	if (!creds) {
		return c.text("Unauthorized", 401, {
			"WWW-Authenticate": 'Basic realm="CalDAV"',
		});
	}

	const user = await verifyAppPassword(c.env.DB, creds.username, creds.password);
	if (!user) {
		return c.text("Unauthorized", 401, {
			"WWW-Authenticate": 'Basic realm="CalDAV"',
		});
	}

	c.set("user", user);
	await next();
};
