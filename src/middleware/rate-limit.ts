import type { Context, MiddlewareHandler } from "hono";

export interface RateLimitOptions {
	windowMs: number;
	max: number;
	keyGenerator: (c: Context) => string;
}

interface RateLimitEntry {
	count: number;
	resetAt: number;
}

// In-memory fallback store (used in test environments where caches API is unavailable)
const memoryStore = new Map<string, RateLimitEntry>();

// When true, forces memory store usage (for testing)
let forceMemoryStore = false;

function cleanupMemoryStore(now: number) {
	for (const [key, entry] of memoryStore) {
		if (now >= entry.resetAt) {
			memoryStore.delete(key);
		}
	}
}

/**
 * Try to use the Cloudflare Cache API for cross-isolate rate limiting.
 * Falls back to in-memory Map when caches API is not available (miniflare/tests).
 */
async function getEntry(
	key: string,
	windowMs: number,
): Promise<{ entry: RateLimitEntry; usedCache: boolean }> {
	const now = Date.now();

	// Try Cache API
	try {
		if (!forceMemoryStore && typeof caches !== "undefined" && caches.default) {
			const cacheKey = new Request(
				`https://rate-limit.internal/${encodeURIComponent(key)}`,
			);
			const cached = await caches.default.match(cacheKey);
			if (cached) {
				const data = (await cached.json()) as RateLimitEntry;
				if (now < data.resetAt) {
					return { entry: data, usedCache: true };
				}
			}
			// No valid entry — create new
			return {
				entry: { count: 0, resetAt: now + windowMs },
				usedCache: true,
			};
		}
	} catch {
		// caches API not available — fall through to memory store
	}

	// Memory fallback
	cleanupMemoryStore(now);
	const existing = memoryStore.get(key);
	if (existing && now < existing.resetAt) {
		return { entry: existing, usedCache: false };
	}
	const newEntry: RateLimitEntry = { count: 0, resetAt: now + windowMs };
	return { entry: newEntry, usedCache: false };
}

async function saveEntry(
	key: string,
	entry: RateLimitEntry,
	usedCache: boolean,
): Promise<void> {
	if (usedCache) {
		try {
			const cacheKey = new Request(
				`https://rate-limit.internal/${encodeURIComponent(key)}`,
			);
			const ttlSeconds = Math.max(
				1,
				Math.ceil((entry.resetAt - Date.now()) / 1000),
			);
			const response = new Response(JSON.stringify(entry), {
				headers: {
					"Content-Type": "application/json",
					"Cache-Control": `max-age=${ttlSeconds}`,
				},
			});
			await caches.default.put(cacheKey, response);
		} catch {
			// Ignore cache write errors
		}
	} else {
		memoryStore.set(key, entry);
	}
}

export function rateLimiter(options: RateLimitOptions): MiddlewareHandler {
	const { windowMs, max, keyGenerator } = options;

	return async (c, next) => {
		const key = keyGenerator(c);
		const { entry, usedCache } = await getEntry(key, windowMs);

		entry.count++;

		const remaining = Math.max(0, max - entry.count);
		const resetEpochSeconds = Math.ceil(entry.resetAt / 1000);

		// Always save updated count
		await saveEntry(key, entry, usedCache);

		// Set rate limit headers
		c.header("X-RateLimit-Limit", String(max));
		c.header("X-RateLimit-Remaining", String(remaining));
		c.header("X-RateLimit-Reset", String(resetEpochSeconds));

		if (entry.count > max) {
			const retryAfterSeconds = Math.max(
				1,
				Math.ceil((entry.resetAt - Date.now()) / 1000),
			);
			c.header("Retry-After", String(retryAfterSeconds));
			return c.text("Too Many Requests", 429);
		}

		await next();
	};
}

/**
 * Key generator: extracts user identity from Basic Auth, session, or IP.
 */
export function defaultKeyGenerator(prefix: string) {
	return (c: Context): string => {
		// Try Basic Auth username
		const authHeader = c.req.header("Authorization") ?? "";
		if (authHeader.startsWith("Basic ")) {
			try {
				const decoded = atob(authHeader.slice(6));
				const username = decoded.split(":")[0];
				if (username) {
					return `${prefix}:basic:${username}`;
				}
			} catch {
				// Ignore decode errors
			}
		}

		// Try Bearer token (for MCP)
		if (authHeader.startsWith("Bearer ")) {
			const token = authHeader.slice(7);
			// Use a hash-like truncation to avoid storing full tokens
			return `${prefix}:bearer:${token.slice(0, 16)}`;
		}

		// Try session user_id (set by authGuard)
		try {
			const user = (c as Context<{ Variables: { user: { id: string } } }>).get(
				"user",
			);
			if (user?.id) {
				return `${prefix}:user:${user.id}`;
			}
		} catch {
			// No user in context
		}

		// Fallback to IP
		const ip =
			c.req.header("CF-Connecting-IP") ??
			c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
			"unknown";
		return `${prefix}:ip:${ip}`;
	};
}

/** Reset the in-memory store (for testing) */
export function _resetMemoryStore(): void {
	memoryStore.clear();
}

/** Pre-seed the in-memory store (for testing — avoids sending many requests) */
export function _seedMemoryStore(
	key: string,
	count: number,
	resetAt: number,
): void {
	memoryStore.set(key, { count, resetAt });
}

/** Force memory store usage, bypassing Cache API (for testing) */
export function _setForceMemoryStore(force: boolean): void {
	forceMemoryStore = force;
}
