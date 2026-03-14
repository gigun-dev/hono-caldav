export class mail {
    constructor(
        public readonly id: string,
        public readonly title: string, // 件名
        public readonly raw: string,   // 本文
        public readonly dueDate: Date, // 受信日（基準日として使用）
        public readonly status: string,
        public readonly priority: string,
        public readonly from: string = '',
    ) {}

    /** LLMへのインプット用に整形する */
    toPromptString(): string {
        // 1. 本文から余計な空行やタグを軽く掃除（任意）
        const cleanBody = this.raw.trim();
        
        // 2. 曜日も含めた基準日を作る
        const refDateStr = this.dueDate.toLocaleDateString("ja-JP", {
            year: "numeric", month: "2-digit", day: "2-digit", weekday: "long"
        });

        // 3. ラベルを付けて構造化
        return `
[メール件名]: ${this.title}
[受信日時]: ${refDateStr}
[メール本文]:
${cleanBody}
`.trim();
    }
}