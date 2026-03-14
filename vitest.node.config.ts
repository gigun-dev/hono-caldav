import { defineConfig } from "vitest/config";

/** Node 環境で実行するテスト（LLM など Worker 不要なユニットテスト） */
export default defineConfig({
	test: {
		include: ["test/llm.test.ts", "test/ics-from-extraction.test.ts"],
		pool: "forks",
		environment: "node",
	},
});
