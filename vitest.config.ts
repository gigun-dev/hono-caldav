import {
	defineWorkersProject,
	readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersProject(async () => {
	const migrations = await readD1Migrations("./migrations");

	return {
		test: {
			setupFiles: ["./test/apply-migrations.ts"],
			poolOptions: {
				workers: {
					wrangler: { configPath: "./wrangler.jsonc" },
					miniflare: {
						bindings: {
							TEST_MIGRATIONS: migrations,
							// Test-only credentials for the in-memory miniflare runtime.
							// These are not real secrets — do not use in production.
							CALDAV_USERNAME: "test-user",
							CALDAV_PASSWORD: "test-pass",
						},
					},
				},
			},
		},
	};
});
