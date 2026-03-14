import { MailThread } from "./MailThread.js";
import type { FeedItem } from "../types.js";

const SYSTEM_PROMPT_TEMPLATE = `あなたは優秀な秘書AIです。提供されたメールスレッドを解析し、**予定**と**タスク**を分別して抽出してください。

### 予定 vs タスクの判定
- **予定 (events)**: 日時・場所が決まった「その時間に起こること」。ミーティング、打ち合わせ、イベント、予約、面談など。開始・終了時刻があることが多い。カレンダーにブロックとして入れるもの。
- **タスク (tasks)**: やるべきこと・TODO・締め切り作業・依頼された作業。「いつまでにやるか」「いつやるか」の日付はあっても、特定の時間帯で行う「予定」ではないもの。

同じメールに「15時から会議」と「レポート提出は金曜まで」があれば、会議→events、レポート→tasks に分けてください。

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
   ### 判定の厳格化（重要）
以下の条件に当てはまるものは、ノイズとして**一切抽出しないでください**。
1. **未確定・候補段階の予定**: 「〜の予定（候補）」「〜か〜のどちらか」「調整中」など、日時や実施自体が確定していないもの。
2. **条件付きのアクション**: 「もし〜なら、やっておいてください」「負荷が高ければ〜」といった、特定の条件を満たさない限り発生しないタスク。
3. **依存関係が未解決なもの**: 「会議が決まったら資料を作る」など、期限のトリガーとなるイベント自体が未確定なもの。
4. **抽象的な願望**: 「いつかやりたい」「〜できればいい」といった、具体的な期限や実施の合意がないもの。

### 抽出のガイドライン
1. **日付の厳密な計算**:
   - **基準日**: {{refDateStr}}
   - **週の定義**: 月曜日を週の始まりとします。
   - 「来週[曜日]」は、基準日が含まれる週の「次の月曜日以降」の曜日を指します。
   (中略)

2. **最新情報の優先**:
   - スレッドの最後の方で「やっぱり15時に変更で」となっていれば、以前の「13時」は破棄し、15時のみを抽出してください。

3. **コンテキストの補完**:
   - タイトルは「[プロジェクト名] 内容」のようにし、場所が「いつもの会議室」などの抽象的な表現の場合は、descriptionに「原文：いつもの会議室」と残した上で、locationはnullにしてください。

### 出力形式
まず、内部で以下の思考プロセス（思考ログ）を実行してください：
- 抽出候補をリストアップする
- それぞれが「確定」か「未確定/条件付き」かを判定する
- 基準日から正確な日付を算出する

### 出力フォーマット (JSONのみ。余計な解説は一切不要)
{
  "events": [
    {
      "date": "YYYY-MM-DD",
      "startTime": "HH:mm",
      "endTime": "HH:mm",
      "title": "予定のタイトル",
      "location": "場所（不明ならnull）",
      "description": "詳細（参加者や備考。最新のメッセージから抽出）"
    }
  ],
  "tasks": [
    {
      "date": "YYYY-MM-DDTHH:mm または YYYY-MM-DD",
      "title": "タスク名",
      "location": "場所（不明ならnull）",
      "description": "詳細（最新のメッセージから抽出）"
    }
  ]
}

- 予定が一つもない場合は "events": []
- タスクが一つもない場合は "tasks": []
- events の startTime/endTime は不明な場合は省略可（date のみでも可）
`;

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
