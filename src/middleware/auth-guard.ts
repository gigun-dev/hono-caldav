import type { MiddlewareHandler } from "hono";

import type { AppBindings } from "../types.js";
import { createAuth } from "../auth/auth.js";

export const authGuard: MiddlewareHandler<AppBindings> = async (c, next) => {
	const auth = createAuth(c.env, c.req.raw.headers);
	const session = await auth.api.getSession({
		headers: c.req.raw.headers,
	});

	if (!session) {
		return c.redirect("/login");
	}

	c.set("user", {
		id: session.user.id,
		username: session.user.email,
		displayName: session.user.name,
	});
	await next();
};
