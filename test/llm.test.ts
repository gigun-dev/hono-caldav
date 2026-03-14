import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FeedItem } from "../src/types.js";
import { FeedItemExtractPrompt } from "../src/Task/prompt.js";
import { ScheduleExtractor } from "../src/Task/openAI.js";

// --- FeedItemExtractPrompt のユニットテスト（LLM 未使用） ---

describe("FeedItemExtractPrompt", () => {
	const sampleFeedItem: FeedItem = {
		id: "feed-1",
		userId: "user-a",
		title: "【打ち合わせ】来週月曜の件",
		content: "[メール件名]: 打ち合わせ\n[受信日時]: 2025/03/15 土曜日\n[メール本文]:\n来週月曜15時から会議室Aで。",
		from: "sender@example.com",
		date: "2025-03-15T09:00:00.000Z",
		sourceType: "email",
	};

	it("getSystemPrompt に基準日（refDateStr）が含まれる", () => {
		const prompt = new FeedItemExtractPrompt(sampleFeedItem);
		const system = prompt.getSystemPrompt();
		expect(system).toContain("基準日");
		expect(system).not.toContain("{{refDateStr}}");
		// 日付は ja-JP でフォーマットされる（例: 2025/03/15 土曜日）
		expect(system).toMatch(/\d{4}\/\d{2}\/\d{2}/);
	});

	it("getSystemPrompt に抽出ガイドラインが含まれる", () => {
		const prompt = new FeedItemExtractPrompt(sampleFeedItem);
		const system = prompt.getSystemPrompt();
		expect(system).toContain("予定やタスクを抽出");
		expect(system).toContain("出力フォーマット");
		expect(system).toContain("JSON");
	});

	it("getUserPrompt は item.content をそのまま返す", () => {
		const prompt = new FeedItemExtractPrompt(sampleFeedItem);
		expect(prompt.getUserPrompt()).toBe(sampleFeedItem.content);
	});
});

// --- ScheduleExtractor のユニットテスト（OpenAI をモック） ---

const mockCreate = vi.fn();

vi.mock("openai", () => ({
	OpenAI: vi.fn().mockImplementation(() => ({
		chat: {
			completions: {
				create: mockCreate,
			},
		},
	})),
}));

describe("ScheduleExtractor", () => {
	beforeEach(() => {
		mockCreate.mockReset();
	});

	it("extractFromFeed は content が空のとき null を返す", async () => {
		const extractor = new ScheduleExtractor({
			apiKey: "test-key",
			model: "test-model",
		});
		const item: FeedItem = {
			id: "e1",
			userId: "u1",
			title: "件名",
			content: "",
			from: "",
			date: new Date().toISOString(),
			sourceType: "email",
		};
		const result = await extractor.extractFromFeed(item);
		expect(result).toBeNull();
		expect(mockCreate).not.toHaveBeenCalled();
	});

	it("extractFromFeed は LLM レスポンスの JSON 文字列を返す", async () => {
		const expectedJson = '{"tasks":[{"date":"2025-03-17","title":"打ち合わせ","location":"会議室A","description":""}]}';
		mockCreate.mockResolvedValue({
			choices: [{ message: { content: expectedJson } }],
		});

		const extractor = new ScheduleExtractor({
			apiKey: "test-key",
			baseURL: "https://api.example.com/v1",
			model: "llama-3.1-8b-instant",
		});
		const item: FeedItem = {
			id: "e1",
			userId: "u1",
			title: "打ち合わせ",
			content: "来週月曜15時から会議室Aで打ち合わせをお願いします。",
			from: "a@example.com",
			date: "2025-03-15T09:00:00.000Z",
			sourceType: "email",
		};

		const result = await extractor.extractFromFeed(item);

		expect(result).toBe(expectedJson);
		expect(mockCreate).toHaveBeenCalledTimes(1);
		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				model: "llama-3.1-8b-instant",
				messages: expect.arrayContaining([
					expect.objectContaining({ role: "system" }),
					expect.objectContaining({ role: "user", content: item.content }),
				]),
				response_format: { type: "json_object" },
				temperature: 0,
			}),
		);
	});

	it("extractFromFeed は LLM がエラーを返したとき null を返す", async () => {
		mockCreate.mockRejectedValue(new Error("API error"));
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const extractor = new ScheduleExtractor({
			apiKey: "test-key",
			model: "test-model",
		});
		const item: FeedItem = {
			id: "e1",
			userId: "u1",
			title: "件名",
			content: "本文",
			from: "",
			date: new Date().toISOString(),
			sourceType: "email",
		};

		const result = await extractor.extractFromFeed(item);

		expect(result).toBeNull();
		consoleSpy.mockRestore();
	});
});
