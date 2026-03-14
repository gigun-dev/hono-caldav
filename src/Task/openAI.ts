import path from "path";
import { fileURLToPath } from "url";
import { OpenAI } from "openai";
import { MailThread } from "./MailThread.js";
import { mail } from "./Unit.js";
import { ScheduleExtractPrompt, FeedItemExtractPrompt } from "./prompt.js";
import type { FeedItem } from "../types.js";

// Workers では import.meta.url が undefined になり得るためガード
const __filename =
	typeof import.meta !== "undefined" && typeof import.meta.url === "string"
		? fileURLToPath(import.meta.url)
		: "";

export interface ScheduleExtractorOptions {
    /** API キー（必須） */
    apiKey: string;
    /** ベースURL（省略時は OpenAI 公式） */
    baseURL?: string;
    /** 使用するモデル名（例: llama-3.1-8b-instant, gpt-4o-mini） */
    model: string;
}

/**
 * apiKey / baseURL / model を指定してスケジュール抽出を行うクラス
 */
export class ScheduleExtractor {
    private readonly client: OpenAI;
    private readonly model: string;

    constructor(options: ScheduleExtractorOptions) {
        this.model = options.model;
        this.client = new OpenAI({
            apiKey: options.apiKey,
            ...(options.baseURL && { baseURL: options.baseURL }),
        });
    }

    /**
     * FeedItem からスケジュール情報を抽出し、生レスポンス（JSON文字列）を返す。
     * メール以外のソース（外部 RSS 等）にも使用可能。
     */
    async extractFromFeed(item: FeedItem): Promise<string | null> {
        if (!item.content) return null;
        const prompt = new FeedItemExtractPrompt(item);

        try {
            const response = await this.client.chat.completions.create({
                model: this.model,
                messages: [
                    { role: "system", content: prompt.getSystemPrompt() },
                    { role: "user", content: prompt.getUserPrompt() },
                ],
                response_format: { type: "json_object" },
                temperature: 0,
            });
            return response.choices[0]?.message?.content ?? null;
        } catch (error) {
            console.error("LLM 抽出エラー:", error);
            return null;
        }
    }

    /**
     * MailThread からスケジュール情報を抽出し、生レスポンス（JSON文字列）を返す
     */
    async extractSchedule(thread: MailThread): Promise<string | null> {
        if (!thread.getLatestMail()) return null;
        const prompt = new ScheduleExtractPrompt(thread);

        try {
            const response = await this.client.chat.completions.create({
                model: this.model,
                messages: [
                    { role: "system", content: prompt.getSystemPrompt() },
                    { role: "user", content: prompt.getUserPrompt() },
                ],
                response_format: { type: "json_object" },
                temperature: 0,
            });
            return response.choices[0]?.message?.content ?? null;
        } catch (error) {
            console.error("LLM 抽出エラー:", error);
            return null;
        }
    }
}

// このファイルを直接実行したときに extractSchedule のテスト（入力・出力をコンソール表示）
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
    (async () => {
        const { config } = await import("dotenv");
        const root = path.resolve(path.dirname(__filename), "../..");
        config({ path: path.join(root, ".env") });
        config({ path: path.join(root, ".env.local") });

        const refDate = new Date("2026-03-03T12:00:00");

        /** 単一メールのスレッド（従来のテスト用） */
        function buildSingleMailThread(): MailThread {
            const t = new MailThread();
            t.addMail(
                new mail(
                    "test-1",
                    "【打ち合わせ】来週月曜の件",
                    "来週月曜の15時から会議室Aで打ち合わせをお願いします。\n参加者: 田中、佐藤",
                    refDate,
                    "todo",
                    "high"
                )
            );
            return t;
        }

        /** 複数メールのスレッド（返信で日時・場所が更新される想定） */
        function buildThreadMailThread(): MailThread {
            const t = new MailThread();
            t.addMail(
                new mail(
                    "thread-1",
                    "Re: 打ち合わせの日程",
                    "来週月曜の14時でいかがでしょうか。会議室Bで。",
                    new Date("2026-03-02T10:00:00"),
                    "todo",
                    "high"
                )
            );
            t.addMail(
                new mail(
                    "thread-2",
                    "Re: 打ち合わせの日程",
                    "14時は別件が入ったので、15時から会議室Aでお願いします。",
                    new Date("2026-03-02T14:00:00"),
                    "todo",
                    "high"
                )
            );
            t.addMail(
                new mail(
                    "thread-3",
                    "Re: 打ち合わせの日程",
                    "承知しました。来週月曜15時、会議室Aで。田中、佐藤の2名で伺います。",
                    refDate,
                    "todo",
                    "high"
                )
            );
            return t;
        }

        const promptOnly = process.argv.includes("--prompt-only");
        const threadOnly = process.argv.includes("--thread");

        if (promptOnly) {
            const thread = threadOnly ? buildThreadMailThread() : buildSingleMailThread();
            const label = threadOnly ? "スレッド（複数メール）" : "単一メール";
            const prompt = new ScheduleExtractPrompt(thread);
            console.log(`--- extractSchedule 送信プロンプト [${label}]（テスト用・LLM未使用） ---\n`);
            console.log("[system]\n");
            console.log(prompt.getSystemPrompt());
            console.log("\n---\n[user]\n");
            console.log(prompt.getUserPrompt());
            console.log("\n--- 以上 ---");
            process.exit(0);
        }

        const apiKey = process.env.GROQ_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
        const extractor = new ScheduleExtractor({
            apiKey,
            baseURL: process.env.OPENAI_BASE_URL ?? "https://api.groq.com/openai/v1",
            model: process.env.SCHEDULE_EXTRACT_MODEL ?? "llama-3.1-8b-instant",
        });

        async function runTest(label: string, thread: MailThread) {
            console.log(`\n========== ${label} ==========\n`);
            console.log("入力 (toPromptString):\n");
            console.log(thread.toPromptString());
            console.log("\n--- LLM 呼び出し中 ---\n");
            const output = await extractor.extractSchedule(thread);
            console.log("出力 (生JSON文字列):\n", output ?? "(null)");
            if (output) {
                try {
                    const parsed = JSON.parse(output);
                    console.log("\nパース後:\n", JSON.stringify(parsed, null, 2));
                } catch {
                    // ignore
                }
            }
        }

        if (threadOnly) {
            await runTest("スレッド（複数メール）", buildThreadMailThread());
        } else {
            await runTest("単一メール", buildSingleMailThread());
            await runTest("スレッド（複数メール）", buildThreadMailThread());
        }
    })();
}