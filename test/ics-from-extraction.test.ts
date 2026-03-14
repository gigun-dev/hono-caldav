import { describe, it, expect } from "vitest";
import type { ExtractedScheduleEvent, ExtractedScheduleTask } from "../src/types.js";
import {
	extractedTaskToVtodoIcs,
	extractedEventToVeventIcs,
} from "../src/caldav/ics-from-extraction.js";
import { isValidComponent } from "../src/caldav/ical.js";

describe("extractedTaskToVtodoIcs", () => {
	it("日付のみのタスクで VTODO ICS を生成し、isValidComponent で VTODO として通る", () => {
		const task: ExtractedScheduleTask = {
			date: "2025-03-20",
			title: "レポート提出",
		};
		const ics = extractedTaskToVtodoIcs(task, "extracted-feed-1-task-0");
		expect(ics).toContain("BEGIN:VTODO");
		expect(ics).toContain("END:VTODO");
		expect(ics).toContain("SUMMARY:レポート提出");
		expect(ics).toMatch(/DUE(;VALUE=DATE)?:20250320/);
		expect(ics).toContain("STATUS:NEEDS-ACTION");
		expect(isValidComponent(ics, "VTODO")).toBe(true);
	});

	it("日時付きのタスクで DUE が DATE-TIME になる", () => {
		const task: ExtractedScheduleTask = {
			date: "2025-03-20T14:00",
			title: "ミーティング準備",
		};
		const ics = extractedTaskToVtodoIcs(task, "uid-1");
		expect(ics).toContain("DUE:20250320T140000");
		expect(isValidComponent(ics, "VTODO")).toBe(true);
	});

	it("description と location を含むタスクで DESCRIPTION/LOCATION がエスケープされる", () => {
		const task: ExtractedScheduleTask = {
			date: "2025-03-21",
			title: "打ち合わせ",
			location: "会議室A",
			description: "詳細メモ\n改行あり",
		};
		const ics = extractedTaskToVtodoIcs(task, "uid-2");
		expect(ics).toContain("SUMMARY:打ち合わせ");
		expect(ics).toContain("LOCATION");
		expect(ics).toContain("DESCRIPTION");
		expect(ics).toContain("\\n"); // 改行は \n にエスケープ
		expect(isValidComponent(ics, "VTODO")).toBe(true);
	});

	it("title が空のときは（無題）になる", () => {
		const task: ExtractedScheduleTask = {
			date: "2025-03-22",
			title: "",
		};
		const ics = extractedTaskToVtodoIcs(task, "uid-3");
		expect(ics).toContain("SUMMARY:（無題）");
		expect(isValidComponent(ics, "VTODO")).toBe(true);
	});
});

describe("extractedEventToVeventIcs", () => {
	it("開始・終了時刻ありの予定で VEVENT ICS を生成し、isValidComponent で VEVENT として通る", () => {
		const event: ExtractedScheduleEvent = {
			date: "2025-03-20",
			startTime: "15:00",
			endTime: "16:00",
			title: "定例ミーティング",
		};
		const ics = extractedEventToVeventIcs(event, "extracted-feed-1-event-0");
		expect(ics).toContain("BEGIN:VEVENT");
		expect(ics).toContain("END:VEVENT");
		expect(ics).toContain("SUMMARY:定例ミーティング");
		expect(ics).toContain("DTSTART:20250320T150000");
		expect(ics).toContain("DTEND:20250320T160000");
		expect(isValidComponent(ics, "VEVENT")).toBe(true);
	});

	it("時刻なしの予定で終日（DATE）になり DTEND が翌日", () => {
		const event: ExtractedScheduleEvent = {
			date: "2025-03-20",
			title: "オフサイト",
		};
		const ics = extractedEventToVeventIcs(event, "uid-4");
		expect(ics).toContain("DTSTART;VALUE=DATE:20250320");
		expect(ics).toContain("DTEND;VALUE=DATE:20250321");
		expect(isValidComponent(ics, "VEVENT")).toBe(true);
	});

	it("description と location を含む予定で DESCRIPTION/LOCATION が出力される", () => {
		const event: ExtractedScheduleEvent = {
			date: "2025-03-21",
			startTime: "10:00",
			endTime: "11:00",
			title: "面談",
			location: "会議室B",
			description: "備考",
		};
		const ics = extractedEventToVeventIcs(event, "uid-5");
		expect(ics).toContain("LOCATION");
		expect(ics).toContain("DESCRIPTION");
		expect(isValidComponent(ics, "VEVENT")).toBe(true);
	});

	it("title が空のときは（無題）になる", () => {
		const event: ExtractedScheduleEvent = {
			date: "2025-03-22",
			title: "",
		};
		const ics = extractedEventToVeventIcs(event, "uid-6");
		expect(ics).toContain("SUMMARY:（無題）");
		expect(isValidComponent(ics, "VEVENT")).toBe(true);
	});
});
