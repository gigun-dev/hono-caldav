/**
 * Demo mode handlers.
 *
 * GET /demo → anonymous sign-up, seed data, redirect to dashboard.
 * POST /demo/seed → seed data for authenticated user (Basic Auth, E2E 用).
 */

import type { Context } from "hono";
import type { AppBindings } from "../types.js";
import { createAuth } from "../auth/auth.js";
import { seedDemoData } from "./seed.js";

/**
 * GET /demo — ワンクリックデモ体験
 * 匿名サインアップ → seed データ作成 → ダッシュボードへリダイレクト
 */
export async function handleDemo(c: Context<AppBindings>): Promise<Response> {
	const env = c.env;
	const auth = createAuth(env, c.req.raw.headers);

	// 既存セッションを破棄
	await auth.api
		.signOut({
			headers: c.req.raw.headers,
			returnHeaders: true,
		})
		.catch(() => null);

	// Anonymous sign-in
	const anonResult = await auth.api.signInAnonymous({
		returnHeaders: true,
	});

	if (!anonResult?.headers) {
		return c.text("Failed to create anonymous user", 500);
	}

	const sessionCookie = anonResult.headers.get("set-cookie");
	if (!sessionCookie) {
		return c.text("Failed to create demo session", 500);
	}

	// Get session to retrieve user ID
	const cookieHeader = sessionCookie
		.split(",")
		.map((cookie) => cookie.split(";")[0].trim())
		.join("; ");
	const session = await auth.api.getSession({
		headers: new Headers({ cookie: cookieHeader }),
	});

	if (!session) {
		return c.text("Failed to retrieve demo session", 500);
	}

	// Seed demo calendars and tasks
	await seedDemoData(env.DB, session.user.id);

	// Redirect to dashboard with session cookies
	const res = new Response(null, {
		status: 302,
		headers: { Location: "/dashboard" },
	});
	for (const value of sessionCookie.split(/,(?=\s*\w+=)/)) {
		res.headers.append("Set-Cookie", value.trim());
	}
	return res;
}

/**
 * POST /demo/seed — E2E テスト用
 * CalDAV Basic Auth で認証済みのユーザーに seed データを作成
 */
export async function handleDemoSeed(
	c: Context<AppBindings>,
): Promise<Response> {
	const user = c.get("user");
	await seedDemoData(c.env.DB, user.id);
	return c.json({ ok: true, userId: user.id });
}
