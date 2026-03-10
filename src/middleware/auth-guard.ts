import { createMiddleware } from "hono/factory";
import { createAuth } from "../auth/auth.js";

export const authGuard = createMiddleware<{
	Bindings: CloudflareBindings;
	Variables: { user: { id: string; name: string; email: string; image: string | null }; session: { id: string; token: string } };
}>(async (c, next) => {
	const auth = createAuth(c.env);
	const session = await auth.api.getSession({
		headers: c.req.raw.headers,
	});
	if (!session) {
		return c.redirect("/login");
	}
	c.set("user", session.user as { id: string; name: string; email: string; image: string | null });
	c.set("session", session.session as { id: string; token: string });
	await next();
});
