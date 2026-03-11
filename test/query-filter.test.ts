import { describe, it, expect } from "vitest";
import {
	parseCalendarFilter,
	applyFilter,
} from "../src/caldav/query-filter.js";
import type { CalendarObject } from "../src/caldav/storage.js";

function makeObj(uid: string, icsData: string): CalendarObject {
	return {
		id: 1,
		calendarId: 1,
		uid,
		etag: `"${uid}"`,
		icsData,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

const VTODO_ICS = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:todo-1\r\nSUMMARY:Buy milk\r\nEND:VTODO\r\nEND:VCALENDAR`;

const VEVENT_ICS = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:event-1\r\nSUMMARY:Meeting\r\nDTSTART:20260315T100000Z\r\nDTEND:20260315T110000Z\r\nEND:VEVENT\r\nEND:VCALENDAR`;

const COMPLETED_TODO = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:todo-done\r\nSUMMARY:Done task\r\nSTATUS:COMPLETED\r\nCOMPLETED:20260310T120000Z\r\nEND:VTODO\r\nEND:VCALENDAR`;

const TODO_WITH_DUE = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:todo-due\r\nSUMMARY:Task with due\r\nDTSTART:20260320T090000Z\r\nDUE:20260325T170000Z\r\nEND:VTODO\r\nEND:VCALENDAR`;

describe("parseCalendarFilter", () => {
	it("returns null for body without filter", () => {
		expect(parseCalendarFilter("<d:propfind/>")).toBeNull();
	});

	it("parses VTODO comp-filter", () => {
		const body = `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VTODO"/>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
		const filter = parseCalendarFilter(body);
		expect(filter).not.toBeNull();
		expect(filter!.name).toBe("VCALENDAR");
		expect(filter!.compFilters.length).toBe(1);
		expect(filter!.compFilters[0].name).toBe("VTODO");
	});

	it("parses time-range filter", () => {
		const body = `<c:filter>
  <c:comp-filter name="VCALENDAR">
    <c:comp-filter name="VEVENT">
      <c:time-range start="20260301T000000Z" end="20260401T000000Z"/>
    </c:comp-filter>
  </c:comp-filter>
</c:filter>`;
		const filter = parseCalendarFilter(body);
		expect(filter!.compFilters[0].timeRange).toBeDefined();
		expect(filter!.compFilters[0].timeRange!.start).toBe("20260301T000000Z");
		expect(filter!.compFilters[0].timeRange!.end).toBe("20260401T000000Z");
	});

	it("parses prop-filter with is-not-defined", () => {
		const body = `<c:filter>
  <c:comp-filter name="VCALENDAR">
    <c:comp-filter name="VTODO">
      <c:prop-filter name="COMPLETED">
        <c:is-not-defined/>
      </c:prop-filter>
    </c:comp-filter>
  </c:comp-filter>
</c:filter>`;
		const filter = parseCalendarFilter(body);
		const pf = filter!.compFilters[0].propFilters[0];
		expect(pf.name).toBe("COMPLETED");
		expect(pf.isNotDefined).toBe(true);
	});

	it("parses text-match filter", () => {
		const body = `<c:filter>
  <c:comp-filter name="VCALENDAR">
    <c:comp-filter name="VTODO">
      <c:prop-filter name="STATUS">
        <c:text-match collation="i;ascii-casemap">COMPLETED</c:text-match>
      </c:prop-filter>
    </c:comp-filter>
  </c:comp-filter>
</c:filter>`;
		const filter = parseCalendarFilter(body);
		const tm = filter!.compFilters[0].propFilters[0].textMatch;
		expect(tm).toBeDefined();
		expect(tm!.value).toBe("COMPLETED");
		expect(tm!.collation).toBe("i;ascii-casemap");
	});
});

describe("applyFilter - comp-filter", () => {
	const objects = [
		makeObj("todo-1", VTODO_ICS),
		makeObj("event-1", VEVENT_ICS),
		makeObj("todo-done", COMPLETED_TODO),
	];

	it("filters VTODOs only", () => {
		const filter = parseCalendarFilter(`<c:filter>
  <c:comp-filter name="VCALENDAR">
    <c:comp-filter name="VTODO"/>
  </c:comp-filter>
</c:filter>`)!;
		const result = applyFilter(objects, filter);
		expect(result.length).toBe(2); // todo-1 and todo-done
		expect(result.every((o) => o.icsData.includes("VTODO"))).toBe(true);
	});

	it("filters VEVENTs only", () => {
		const filter = parseCalendarFilter(`<c:filter>
  <c:comp-filter name="VCALENDAR">
    <c:comp-filter name="VEVENT"/>
  </c:comp-filter>
</c:filter>`)!;
		const result = applyFilter(objects, filter);
		expect(result.length).toBe(1);
		expect(result[0].uid).toBe("event-1");
	});

	it("returns all objects when no inner comp-filter", () => {
		const filter = parseCalendarFilter(`<c:filter>
  <c:comp-filter name="VCALENDAR"/>
</c:filter>`)!;
		const result = applyFilter(objects, filter);
		expect(result.length).toBe(3);
	});
});

describe("applyFilter - prop-filter", () => {
	const objects = [
		makeObj("todo-1", VTODO_ICS),
		makeObj("todo-done", COMPLETED_TODO),
	];

	it("parses prop-filter with is-not-defined correctly", () => {
		const filter = parseCalendarFilter(`<c:filter>
  <c:comp-filter name="VCALENDAR">
    <c:comp-filter name="VTODO">
      <c:prop-filter name="COMPLETED">
        <c:is-not-defined/>
      </c:prop-filter>
    </c:comp-filter>
  </c:comp-filter>
</c:filter>`)!;
		expect(filter.compFilters.length).toBe(1);
		expect(filter.compFilters[0].name).toBe("VTODO");
		expect(filter.compFilters[0].propFilters.length).toBe(1);
		expect(filter.compFilters[0].propFilters[0].name).toBe("COMPLETED");
		expect(filter.compFilters[0].propFilters[0].isNotDefined).toBe(true);
	});

	it("filters tasks WITHOUT COMPLETED property", () => {
		const filter = parseCalendarFilter(`<c:filter>
  <c:comp-filter name="VCALENDAR">
    <c:comp-filter name="VTODO">
      <c:prop-filter name="COMPLETED">
        <c:is-not-defined/>
      </c:prop-filter>
    </c:comp-filter>
  </c:comp-filter>
</c:filter>`)!;
		const result = applyFilter(objects, filter);
		expect(result.length).toBe(1);
		expect(result[0].uid).toBe("todo-1");
	});

	it("filters tasks WITH COMPLETED property", () => {
		const filter = parseCalendarFilter(`<c:filter>
  <c:comp-filter name="VCALENDAR">
    <c:comp-filter name="VTODO">
      <c:prop-filter name="COMPLETED"/>
    </c:comp-filter>
  </c:comp-filter>
</c:filter>`)!;
		const result = applyFilter(objects, filter);
		expect(result.length).toBe(1);
		expect(result[0].uid).toBe("todo-done");
	});

	it("filters by STATUS text-match", () => {
		const filter = parseCalendarFilter(`<c:filter>
  <c:comp-filter name="VCALENDAR">
    <c:comp-filter name="VTODO">
      <c:prop-filter name="STATUS">
        <c:text-match collation="i;ascii-casemap">COMPLETED</c:text-match>
      </c:prop-filter>
    </c:comp-filter>
  </c:comp-filter>
</c:filter>`)!;
		const result = applyFilter(objects, filter);
		expect(result.length).toBe(1);
		expect(result[0].uid).toBe("todo-done");
	});
});

describe("applyFilter - time-range", () => {
	it("filters VEVENTs by time-range (in range)", () => {
		const objects = [makeObj("event-1", VEVENT_ICS)];
		const filter = parseCalendarFilter(`<c:filter>
  <c:comp-filter name="VCALENDAR">
    <c:comp-filter name="VEVENT">
      <c:time-range start="20260301T000000Z" end="20260401T000000Z"/>
    </c:comp-filter>
  </c:comp-filter>
</c:filter>`)!;
		const result = applyFilter(objects, filter);
		expect(result.length).toBe(1);
	});

	it("excludes VEVENTs outside time-range", () => {
		const objects = [makeObj("event-1", VEVENT_ICS)];
		const filter = parseCalendarFilter(`<c:filter>
  <c:comp-filter name="VCALENDAR">
    <c:comp-filter name="VEVENT">
      <c:time-range start="20260101T000000Z" end="20260201T000000Z"/>
    </c:comp-filter>
  </c:comp-filter>
</c:filter>`)!;
		const result = applyFilter(objects, filter);
		expect(result.length).toBe(0);
	});

	it("filters VTODOs with DUE in time-range", () => {
		const objects = [makeObj("todo-due", TODO_WITH_DUE)];
		const filter = parseCalendarFilter(`<c:filter>
  <c:comp-filter name="VCALENDAR">
    <c:comp-filter name="VTODO">
      <c:time-range start="20260301T000000Z" end="20260401T000000Z"/>
    </c:comp-filter>
  </c:comp-filter>
</c:filter>`)!;
		const result = applyFilter(objects, filter);
		expect(result.length).toBe(1);
	});

	it("excludes VTODOs with DUE outside time-range", () => {
		const objects = [makeObj("todo-due", TODO_WITH_DUE)];
		const filter = parseCalendarFilter(`<c:filter>
  <c:comp-filter name="VCALENDAR">
    <c:comp-filter name="VTODO">
      <c:time-range start="20260101T000000Z" end="20260201T000000Z"/>
    </c:comp-filter>
  </c:comp-filter>
</c:filter>`)!;
		const result = applyFilter(objects, filter);
		expect(result.length).toBe(0);
	});

	it("includes undated VTODOs in any time-range", () => {
		const objects = [makeObj("todo-1", VTODO_ICS)];
		const filter = parseCalendarFilter(`<c:filter>
  <c:comp-filter name="VCALENDAR">
    <c:comp-filter name="VTODO">
      <c:time-range start="20260101T000000Z" end="20260201T000000Z"/>
    </c:comp-filter>
  </c:comp-filter>
</c:filter>`)!;
		const result = applyFilter(objects, filter);
		expect(result.length).toBe(1); // undated tasks always match
	});
});

describe("applyFilter - combined filters", () => {
	it("filters incomplete VTODOs with DUE in range (AND logic)", () => {
		const objects = [
			makeObj("todo-1", VTODO_ICS),
			makeObj("todo-done", COMPLETED_TODO),
			makeObj("todo-due", TODO_WITH_DUE),
		];
		const filter = parseCalendarFilter(`<c:filter>
  <c:comp-filter name="VCALENDAR">
    <c:comp-filter name="VTODO">
      <c:prop-filter name="COMPLETED">
        <c:is-not-defined/>
      </c:prop-filter>
      <c:time-range start="20260301T000000Z" end="20260401T000000Z"/>
    </c:comp-filter>
  </c:comp-filter>
</c:filter>`)!;
		const result = applyFilter(objects, filter);
		// todo-1: no COMPLETED, undated→matches time-range → included
		// todo-done: HAS COMPLETED → excluded by prop-filter
		// todo-due: no COMPLETED, DUE in range → included
		expect(result.length).toBe(2);
		expect(result.map((o) => o.uid).sort()).toEqual(["todo-1", "todo-due"]);
	});
});

describe("applyFilter - text-match variations", () => {
	const TASK_A = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:task-a\r\nSUMMARY:Buy groceries\r\nEND:VTODO\r\nEND:VCALENDAR`;
	const TASK_B = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:task-b\r\nSUMMARY:Sell old books\r\nEND:VTODO\r\nEND:VCALENDAR`;
	const objects = [makeObj("task-a", TASK_A), makeObj("task-b", TASK_B)];

	it("match-type equals", () => {
		const filter = parseCalendarFilter(`<c:filter>
  <c:comp-filter name="VCALENDAR">
    <c:comp-filter name="VTODO">
      <c:prop-filter name="SUMMARY">
        <c:text-match match-type="equals">Buy groceries</c:text-match>
      </c:prop-filter>
    </c:comp-filter>
  </c:comp-filter>
</c:filter>`)!;
		const result = applyFilter(objects, filter);
		expect(result.length).toBe(1);
		expect(result[0].uid).toBe("task-a");
	});

	it("match-type starts-with", () => {
		const filter = parseCalendarFilter(`<c:filter>
  <c:comp-filter name="VCALENDAR">
    <c:comp-filter name="VTODO">
      <c:prop-filter name="SUMMARY">
        <c:text-match match-type="starts-with">Sell</c:text-match>
      </c:prop-filter>
    </c:comp-filter>
  </c:comp-filter>
</c:filter>`)!;
		const result = applyFilter(objects, filter);
		expect(result.length).toBe(1);
		expect(result[0].uid).toBe("task-b");
	});

	it("match-type ends-with", () => {
		const filter = parseCalendarFilter(`<c:filter>
  <c:comp-filter name="VCALENDAR">
    <c:comp-filter name="VTODO">
      <c:prop-filter name="SUMMARY">
        <c:text-match match-type="ends-with">groceries</c:text-match>
      </c:prop-filter>
    </c:comp-filter>
  </c:comp-filter>
</c:filter>`)!;
		const result = applyFilter(objects, filter);
		expect(result.length).toBe(1);
		expect(result[0].uid).toBe("task-a");
	});

	it("negate-condition excludes matches", () => {
		const filter = parseCalendarFilter(`<c:filter>
  <c:comp-filter name="VCALENDAR">
    <c:comp-filter name="VTODO">
      <c:prop-filter name="SUMMARY">
        <c:text-match negate-condition="yes">Buy</c:text-match>
      </c:prop-filter>
    </c:comp-filter>
  </c:comp-filter>
</c:filter>`)!;
		const result = applyFilter(objects, filter);
		expect(result.length).toBe(1);
		expect(result[0].uid).toBe("task-b");
	});

	it("case-insensitive match with i;ascii-casemap", () => {
		const filter = parseCalendarFilter(`<c:filter>
  <c:comp-filter name="VCALENDAR">
    <c:comp-filter name="VTODO">
      <c:prop-filter name="SUMMARY">
        <c:text-match collation="i;ascii-casemap">buy</c:text-match>
      </c:prop-filter>
    </c:comp-filter>
  </c:comp-filter>
</c:filter>`)!;
		const result = applyFilter(objects, filter);
		expect(result.length).toBe(1);
		expect(result[0].uid).toBe("task-a");
	});
});

describe("applyFilter - VTODO time-range edge cases", () => {
	const TODO_COMPLETED_ONLY = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:todo-comp-only\r\nSUMMARY:Completed only\r\nSTATUS:COMPLETED\r\nCOMPLETED:20260315T120000Z\r\nEND:VTODO\r\nEND:VCALENDAR`;

	const TODO_COMPLETED_CREATED = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:todo-comp-created\r\nSUMMARY:With created\r\nSTATUS:COMPLETED\r\nCREATED:20260301T000000Z\r\nCOMPLETED:20260310T120000Z\r\nEND:VTODO\r\nEND:VCALENDAR`;

	it("VTODO with only COMPLETED — in range", () => {
		const objects = [makeObj("todo-comp-only", TODO_COMPLETED_ONLY)];
		const filter = parseCalendarFilter(`<c:filter>
  <c:comp-filter name="VCALENDAR">
    <c:comp-filter name="VTODO">
      <c:time-range start="20260301T000000Z" end="20260401T000000Z"/>
    </c:comp-filter>
  </c:comp-filter>
</c:filter>`)!;
		expect(applyFilter(objects, filter).length).toBe(1);
	});

	it("VTODO with only COMPLETED — out of range", () => {
		const objects = [makeObj("todo-comp-only", TODO_COMPLETED_ONLY)];
		const filter = parseCalendarFilter(`<c:filter>
  <c:comp-filter name="VCALENDAR">
    <c:comp-filter name="VTODO">
      <c:time-range start="20260101T000000Z" end="20260201T000000Z"/>
    </c:comp-filter>
  </c:comp-filter>
</c:filter>`)!;
		expect(applyFilter(objects, filter).length).toBe(0);
	});

	it("VTODO with COMPLETED+CREATED — in range", () => {
		const objects = [makeObj("todo-comp-created", TODO_COMPLETED_CREATED)];
		const filter = parseCalendarFilter(`<c:filter>
  <c:comp-filter name="VCALENDAR">
    <c:comp-filter name="VTODO">
      <c:time-range start="20260301T000000Z" end="20260401T000000Z"/>
    </c:comp-filter>
  </c:comp-filter>
</c:filter>`)!;
		expect(applyFilter(objects, filter).length).toBe(1);
	});

	it("VTODO with COMPLETED+CREATED — out of range (before created)", () => {
		const objects = [makeObj("todo-comp-created", TODO_COMPLETED_CREATED)];
		const filter = parseCalendarFilter(`<c:filter>
  <c:comp-filter name="VCALENDAR">
    <c:comp-filter name="VTODO">
      <c:time-range start="20260101T000000Z" end="20260201T000000Z"/>
    </c:comp-filter>
  </c:comp-filter>
</c:filter>`)!;
		expect(applyFilter(objects, filter).length).toBe(0);
	});

	it("VTODO with only DTSTART — matches if filter end is after DTSTART", () => {
		const TODO_DTSTART_ONLY = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:todo-ds\r\nSUMMARY:Start only\r\nDTSTART:20260315T090000Z\r\nEND:VTODO\r\nEND:VCALENDAR`;
		const objects = [makeObj("todo-ds", TODO_DTSTART_ONLY)];
		const filter = parseCalendarFilter(`<c:filter>
  <c:comp-filter name="VCALENDAR">
    <c:comp-filter name="VTODO">
      <c:time-range start="20260301T000000Z" end="20260401T000000Z"/>
    </c:comp-filter>
  </c:comp-filter>
</c:filter>`)!;
		expect(applyFilter(objects, filter).length).toBe(1);
	});
});
