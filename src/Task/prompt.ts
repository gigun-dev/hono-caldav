import { MailThread } from "./MailThread.js";
import type { FeedItem } from "../types.js";

const SYSTEM_PROMPT_TEMPLATE = `あなたは優秀な秘書AIです。提供されたメールスレッドを解析し、確定した予定やタスクを抽出してください。

### 抽出のガイドライン
1. **日付の厳密な計算**:
   - **基準日**: {{refDateStr}}
   - 相対表現（明日、来週、来週月曜など）がある場合、以下のステップで計算してください：
     a) 基準日の曜日を特定する。
     b) ターゲットとなる曜日までの日数を数える。
     c) 基準日にその日数を加算して正確な日付（YYYY-MM-DD）を算出する。
   - 「来週月曜」は、基準日の「次の月曜日」ではなく、基準日が含まれる週の「次の週の月曜日」を指します。
   - 本文中の \`(YYYY/MM/DD)\` や \`(YYYY/MM/DD HH:mm)\` はシステムによる補助計算です。文脈的に「来週(03/02)」のように過去の日付になっていて不自然な場合は、あなたの判断で正しい未来の日付に修正して抽出してください。

2. **最新情報の優先（スレッド解析）**:
   - メッセージの時間軸を追い、一度提案された日時が後の返信で変更・修正されている場合は、必ず**最新の合意内容**のみを抽出してください。

3. **内容の要約**:
   - タイトルはカレンダー視認性を重視し、「件名：内容」のように簡潔にまとめてください。

### 出力フォーマット (JSONのみ。余計な解説は一切不要)
{
  "tasks": [
    {
      "date": "YYYY-MM-DDTHH:mm または YYYY-MM-DD",
      "title": "タスク名",
      "location": "場所（不明ならnull）",
      "description": "詳細（参加人数や備考。最新のメッセージから抽出）"
    }
  ]
}`;

/**
 * スケジュール抽出用のプロンプトを生成するクラス
 */
export class ScheduleExtractPrompt {
    constructor(private readonly thread: MailThread) {}

    /** システムプロンプト（基準日込み）を返す */
    getSystemPrompt(): string {
        const refDateStr = this.getRefDateStr();
        return SYSTEM_PROMPT_TEMPLATE.replace("{{refDateStr}}", refDateStr);
    }

    /** ユーザープロンプト（スレッド本文）を返す */
    getUserPrompt(): string {
        return this.thread.toPromptString();
    }

    private getRefDateStr(): string {
        const latest = this.thread.getLatestMail();
        if (!latest) return "(なし)";
        return latest.dueDate.toLocaleDateString("ja-JP", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            weekday: "long",
        });
    }
}

/**
 * FeedItem からスケジュール抽出用プロンプトを生成するクラス。
 * MailThread に依存しないため、メール以外のソースにも使用可能。
 */
export class FeedItemExtractPrompt {
    constructor(private readonly item: FeedItem) {}

    getSystemPrompt(): string {
        const refDateStr = new Date(this.item.date).toLocaleDateString("ja-JP", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            weekday: "long",
        });
        return SYSTEM_PROMPT_TEMPLATE.replace("{{refDateStr}}", refDateStr);
    }

    getUserPrompt(): string {
        return this.item.content;
    }
}
