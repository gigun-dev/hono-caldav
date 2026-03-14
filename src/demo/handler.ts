/**
 * Demo mode handler.
 * GET /demo → create/reuse demo user, seed data, redirect to dashboard.
 *
 * Fixed mode (DEMO_EMAIL set): uses env values, reuses same user on re-visit.
 * Random mode (DEMO_EMAIL unset): creates a new random user each time.
 */

import type { Context } from "hono";
import type { AppBindings } from "../types.js";
import { createAuth } from "../auth/auth.js";
import { seedDemoData } from "./seed.js";

export async function handleDemo(c: Context<AppBindings>): Promise<Response> {
	const env = c.env;
	const fixed = !!env.DEMO_EMAIL;

	// Generate email/password
	const email = fixed
		? env.DEMO_EMAIL!
		: `demo-${crypto.randomUUID().slice(0, 8)}@demo.caldav.local`;
	const password = fixed
		? (env.DEMO_PASSWORD ?? "changeme")
		: crypto.randomUUID();
	const name = "Demo User";

	const auth = createAuth(env, c.req.raw.headers);

	// 既存セッションを破棄（Gmail → Demo 切り替え時に必要）
	const signOutRes = await auth.api.signOut({
		headers: c.req.raw.headers,
		returnHeaders: true,
	}).catch(() => null);
	const clearCookieHeaders: string[] = [];
	if (signOutRes?.headers) {
		for (const value of (signOutRes.headers.get("set-cookie") ?? "").split(/,(?=\s*\w+=)/)) {
			if (value.trim()) clearCookieHeaders.push(value.trim());
		}
	}

	// Try sign-in first (fixed mode reuse), then sign-up
	let sessionHeaders: Headers | undefined;

	// Try sign-up first, then sign-in (for fixed mode re-visit)
	const signUp = await auth.api.signUpEmail({
		body: { email, password, name },
		returnHeaders: true,
	}).catch(() => null);

	if (signUp) {
		sessionHeaders = signUp.headers;
	} else if (fixed) {
		// User already exists — sign in
		const signIn = await auth.api.signInEmail({
			body: { email, password },
			returnHeaders: true,
		}).catch((e: unknown) => {
			console.error("[Demo] signIn failed:", e);
			return null;
		});
		if (signIn) {
			sessionHeaders = signIn.headers;
		}
	}

	if (!sessionHeaders) {
		return c.text("Failed to create or sign in demo user", 500);
	}

	// Get user ID from session
	const sessionCookie = sessionHeaders.get("set-cookie");
	if (!sessionCookie) {
		return c.text("Failed to create demo session", 500);
	}

	// Extract session to get user ID for seeding
	const cookieHeader = sessionCookie
		.split(",")
		.map((c) => c.split(";")[0].trim())
		.join("; ");
	const session = await auth.api.getSession({
		headers: new Headers({ cookie: cookieHeader }),
	});

	if (session) {
		await seedDemoData(env.DB, session.user.id, {
			appPassword: fixed ? env.DEMO_APP_PASSWORD : undefined,
		});
	} else {
		console.warn("[Demo] Could not retrieve session after sign-up");
	}

	// Redirect with session cookies (signOut のクリア + 新セッション)
	const res = new Response(null, {
		status: 302,
		headers: {
			Location: "/dashboard",
		},
	});
	for (const value of clearCookieHeaders) {
		res.headers.append("Set-Cookie", value);
	}
	for (const value of sessionCookie.split(/,(?=\s*\w+=)/)) {
		res.headers.append("Set-Cookie", value.trim());
	}
	return res;
}
