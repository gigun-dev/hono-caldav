import { mail } from "./Unit";
import type { FeedItem } from "../types.js";

export class MailThread {
    private mails: mail[] = [];

    addMail(mail: mail) {
        this.mails.push(mail);
    }

    getMails() {
        return this.mails;
    }

    getLatestMail() {
        return this.mails[this.mails.length - 1];
    }

    toPromptString(): string {
        return this.mails.map(mail => mail.toPromptString()).join("\n");
    }

    /** スレッドを FeedItem に変換する。title/from/date はスレッド最初のメールから取得。 */
    toFeedItem(threadId: string, userId = ''): FeedItem {
        const first = this.mails[0];
        return {
            id: threadId,
            userId,
            title: first?.title ?? '(件名なし)',
            content: this.toPromptString(),
            from: first?.from ?? '',
            date: first?.dueDate.toISOString() ?? new Date().toISOString(),
            sourceType: 'email',
        };
    }
}