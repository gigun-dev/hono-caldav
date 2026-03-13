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
							BETTER_AUTH_ALLOWED_HOSTS: "localhost",
							BETTER_AUTH_SECRET: "test-secret",
							GOOGLE_CLIENT_ID: "test",
							GOOGLE_CLIENT_SECRET: "test",
						},
					},
				},
			},
		},
	};
});
