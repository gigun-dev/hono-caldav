/**
 * CalDAV calendar-query REPORT filter (RFC 4791 §7.8, §9.7).
 * Parses <c:filter> XML and matches calendar objects.
 */

import type { CalendarObject } from "./storage.js";

// --- Filter types ---

export type CompFilter = {
	name: string; // VCALENDAR, VEVENT, VTODO, etc.
	isNotDefined?: boolean;
	timeRange?: TimeRange;
	compFilters: CompFilter[];
	propFilters: PropFilter[];
};

export type PropFilter = {
	name: string; // STATUS, COMPLETED, SUMMARY, etc.
	isNotDefined?: boolean;
	textMatch?: TextMatch;
	timeRange?: TimeRange;
};

export type TextMatch = {
	value: string;
	collation: string;
	negateCondition: boolean;
	matchType: string; // contains, equals, starts-with, ends-with
};

export type TimeRange = {
	start?: string; // UTC: 20260301T000000Z
	end?: string;
};

// --- Parsing ---

/**
 * Parse <c:filter> from calendar-query REPORT body.
 * Returns null if no filter found (return all objects).
 */
export function parseCalendarFilter(body: string): CompFilter | null {
	// Extract content between <c:filter> and </c:filter>
	const filterMatch = body.match(
		/<(?:[^:>]+:)?filter\b[^>]*>([\s\S]*?)<\/(?:[^:>]+:)?filter>/i,
	);
	if (!filterMatch) return null;

	return parseCompFilterFromXml(filterMatch[1]);
}

/**
 * Parse the first comp-filter from XML content.
 * Uses a bracket-counting approach to handle nested comp-filters.
 */
function parseCompFilterFromXml(xml: string): CompFilter | null {
	// Find opening comp-filter tag
	const openMatch = xml.match(
		/<(?:[^:>]+:)?comp-filter\s+name="([^"]+)"([^>]*?)(\/?)\s*>/i,
	);
	if (!openMatch) return null;

	const name = openMatch[1].toUpperCase();
	const selfClosing = openMatch[3] === "/";

	if (selfClosing) {
		return { name, compFilters: [], propFilters: [] };
	}

	// Find the matching closing tag by counting nesting
	const openTagEnd = openMatch.index! + openMatch[0].length;
	const innerContent = extractInnerContent(xml, openTagEnd, "comp-filter");

	if (innerContent === null) {
		return { name, compFilters: [], propFilters: [] };
	}

	// is-not-defined must be a direct child, not nested inside comp-filter/prop-filter
	const isNotDefined = isDirectChildIsNotDefined(innerContent);
	const timeRange = parseDirectTimeRange(innerContent);
	const compFilters = parseAllNestedCompFilters(innerContent);
	const propFilters = parseAllPropFilters(innerContent);

	return { name, isNotDefined, timeRange, compFilters, propFilters };
}

/**
 * Extract content between the current position and the matching closing tag,
 * properly handling nested elements with the same tag name.
 */
function extractInnerContent(
	xml: string,
	startPos: number,
	tagName: string,
): string | null {
	const openPattern = new RegExp(
		`<(?:[^:>]+:)?${tagName}\\b[^>]*(?<!/)>`,
		"gi",
	);
	const closePattern = new RegExp(
		`<\\/(?:[^:>]+:)?${tagName}\\s*>`,
		"gi",
	);
	let depth = 1;
	const remaining = xml.slice(startPos);

	// Simple scan: find all opening/closing tags and track depth
	const allTags: { index: number; type: "open" | "close" | "selfclose" }[] =
		[];

	let m: RegExpExecArray | null;

	openPattern.lastIndex = 0;
	while ((m = openPattern.exec(remaining)) !== null) {
		// Exclude self-closing tags
		if (!m[0].endsWith("/>")) {
			allTags.push({ index: m.index, type: "open" });
		}
	}

	closePattern.lastIndex = 0;
	while ((m = closePattern.exec(remaining)) !== null) {
		allTags.push({ index: m.index, type: "close" });
	}

	// Sort by position
	allTags.sort((a, b) => a.index - b.index);

	for (const tag of allTags) {
		if (tag.type === "open") {
			depth++;
		} else if (tag.type === "close") {
			depth--;
			if (depth === 0) {
				return remaining.slice(0, tag.index);
			}
		}
	}

	return remaining; // No matching close found, return everything
}

/**
 * Parse all immediate child comp-filters from inner XML content.
 */
function parseAllNestedCompFilters(xml: string): CompFilter[] {
	const results: CompFilter[] = [];
	const regex =
		/<(?:[^:>]+:)?comp-filter\s+name="([^"]+)"([^>]*?)(\/?)\s*>/gi;
	let m: RegExpExecArray | null;

	while ((m = regex.exec(xml)) !== null) {
		const name = m[1].toUpperCase();
		const selfClosing = m[3] === "/";

		if (selfClosing) {
			results.push({ name, compFilters: [], propFilters: [] });
			continue;
		}

		const innerStart = m.index + m[0].length;
		const innerContent = extractInnerContent(xml, innerStart, "comp-filter");

		const isNotDefined = innerContent
			? isDirectChildIsNotDefined(innerContent)
			: false;
		const timeRange = innerContent
			? parseDirectTimeRange(innerContent)
			: undefined;
		const propFilters = innerContent
			? parseAllPropFilters(innerContent)
			: [];

		results.push({
			name,
			isNotDefined,
			timeRange,
			compFilters: [],
			propFilters,
		});

		// Skip past the closing tag
		if (innerContent) {
			const closeTag = xml.indexOf(
				">",
				innerStart + innerContent.length,
			);
			if (closeTag >= 0) {
				regex.lastIndex = closeTag + 1;
			}
		}
	}

	return results;
}

/**
 * Check if is-not-defined is a direct child (not nested inside comp-filter or prop-filter).
 */
function isDirectChildIsNotDefined(xml: string): boolean {
	// Strip out all comp-filter and prop-filter blocks first
	const stripped = stripNestedBlocks(xml);
	return /<(?:[^:>]+:)?is-not-defined\s*\/?\s*>/i.test(stripped);
}

/**
 * Parse time-range only if it's a direct child (not nested).
 */
function parseDirectTimeRange(xml: string): TimeRange | undefined {
	const stripped = stripNestedBlocks(xml);
	return parseTimeRange(stripped);
}

/**
 * Remove all comp-filter and prop-filter blocks from XML,
 * leaving only direct children of the current element.
 */
function stripNestedBlocks(xml: string): string {
	let result = xml;
	// Remove comp-filter blocks (including self-closing)
	result = result.replace(
		/<(?:[^:>]+:)?comp-filter\b[\s\S]*?(?:<\/(?:[^:>]+:)?comp-filter\s*>|\/>)/gi,
		"",
	);
	// Remove prop-filter blocks (including self-closing)
	result = result.replace(
		/<(?:[^:>]+:)?prop-filter\b[\s\S]*?(?:<\/(?:[^:>]+:)?prop-filter\s*>|\/>)/gi,
		"",
	);
	return result;
}

function parseAllPropFilters(xml: string): PropFilter[] {
	const results: PropFilter[] = [];
	const regex =
		/<(?:[^:>]+:)?prop-filter\s+name="([^"]+)"[^>]*(?:\/>|>([\s\S]*?)<\/(?:[^:>]+:)?prop-filter>)/gi;
	let m: RegExpExecArray | null;
	while ((m = regex.exec(xml)) !== null) {
		const name = m[1].toUpperCase();
		const inner = m[2] ?? "";
		results.push({
			name,
			isNotDefined: /<(?:[^:>]+:)?is-not-defined\s*\/?\s*>/i.test(inner),
			textMatch: parseTextMatch(inner),
			timeRange: parseTimeRange(inner),
		});
	}
	return results;
}

function parseTimeRange(xml: string): TimeRange | undefined {
	const match = xml.match(
		/<(?:[^:>]+:)?time-range\s+([^>]*?)\/?\s*>/i,
	);
	if (!match) return undefined;

	const attrs = match[1];
	const startMatch = attrs.match(/start="([^"]+)"/i);
	const endMatch = attrs.match(/end="([^"]+)"/i);
	if (!startMatch && !endMatch) return undefined;

	return {
		start: startMatch?.[1],
		end: endMatch?.[1],
	};
}

function parseTextMatch(xml: string): TextMatch | undefined {
	const match = xml.match(
		/<(?:[^:>]+:)?text-match\b([^>]*)>([^<]*)<\/(?:[^:>]+:)?text-match>/i,
	);
	if (!match) return undefined;

	const attrs = match[1];
	const value = match[2];
	const collation =
		attrs.match(/collation="([^"]+)"/i)?.[1] ?? "i;ascii-casemap";
	const negate = attrs.match(/negate-condition="([^"]+)"/i)?.[1] === "yes";
	const matchType =
		attrs.match(/match-type="([^"]+)"/i)?.[1] ?? "contains";

	return { value, collation, negateCondition: negate, matchType };
}

// --- Matching ---

/**
 * Filter calendar objects by parsed comp-filter.
 * The top-level comp-filter should be name="VCALENDAR".
 */
export function applyFilter(
	objects: CalendarObject[],
	filter: CompFilter,
): CalendarObject[] {
	// Top-level must be VCALENDAR — just pass through to inner filters
	if (filter.name !== "VCALENDAR") return objects;
	if (filter.compFilters.length === 0 && filter.propFilters.length === 0) {
		return objects; // No inner filters — return all
	}

	return objects.filter((obj) => matchesFilter(obj.icsData, filter));
}

function matchesFilter(icsData: string, vcalFilter: CompFilter): boolean {
	// Check inner comp-filters (VEVENT, VTODO, etc.) — AND logic
	for (const cf of vcalFilter.compFilters) {
		if (!matchesCompFilter(icsData, cf)) return false;
	}
	return true;
}

function matchesCompFilter(icsData: string, cf: CompFilter): boolean {
	const componentName = cf.name;
	const hasComponent = hasIcsComponent(icsData, componentName);

	if (cf.isNotDefined) {
		return !hasComponent;
	}

	if (!hasComponent) return false;

	// Check time-range on the component
	if (cf.timeRange) {
		if (!matchesTimeRange(icsData, componentName, cf.timeRange)) {
			return false;
		}
	}

	// Check prop-filters (AND logic)
	for (const pf of cf.propFilters) {
		if (!matchesPropFilter(icsData, componentName, pf)) return false;
	}

	return true;
}

function matchesPropFilter(
	icsData: string,
	componentName: string,
	pf: PropFilter,
): boolean {
	const propValue = extractComponentProp(icsData, componentName, pf.name);
	const hasProp = propValue !== null;

	if (pf.isNotDefined) {
		return !hasProp;
	}

	if (!hasProp) return false;

	if (pf.textMatch) {
		return matchesTextMatch(propValue, pf.textMatch);
	}

	if (pf.timeRange) {
		return matchesPropertyTimeRange(propValue, pf.timeRange);
	}

	return true;
}

function matchesTextMatch(value: string, tm: TextMatch): boolean {
	const v = tm.collation === "i;ascii-casemap" ? value.toLowerCase() : value;
	const target =
		tm.collation === "i;ascii-casemap"
			? tm.value.toLowerCase()
			: tm.value;

	let result: boolean;
	switch (tm.matchType) {
		case "equals":
			result = v === target;
			break;
		case "starts-with":
			result = v.startsWith(target);
			break;
		case "ends-with":
			result = v.endsWith(target);
			break;
		case "contains":
		default:
			result = v.includes(target);
			break;
	}

	return tm.negateCondition ? !result : result;
}

// --- ICS helpers ---

function hasIcsComponent(icsData: string, componentName: string): boolean {
	const tag = `BEGIN:${componentName.toUpperCase()}`;
	const lines = icsData.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
	return lines.some((line) => line.trim().toUpperCase() === tag);
}

/**
 * Extract a property value from within a specific component.
 */
function extractComponentProp(
	icsData: string,
	componentName: string,
	propName: string,
): string | null {
	const upper = componentName.toUpperCase();
	const beginTag = `BEGIN:${upper}`;
	const endTag = `END:${upper}`;

	const unfolded = icsData.replace(/\r?\n[ \t]/g, "");
	const lines = unfolded.split(/\r?\n/);

	let inComponent = false;
	for (const line of lines) {
		const lineUpper = line.toUpperCase();
		if (lineUpper.startsWith(beginTag)) {
			inComponent = true;
			continue;
		}
		if (lineUpper.startsWith(endTag)) {
			inComponent = false;
			continue;
		}
		if (inComponent) {
			if (
				lineUpper.startsWith(`${propName.toUpperCase()}:`) ||
				lineUpper.startsWith(`${propName.toUpperCase()};`)
			) {
				const colonIdx = line.indexOf(":");
				if (colonIdx >= 0) {
					return line.slice(colonIdx + 1).trim();
				}
			}
		}
	}
	return null;
}

/**
 * Time-range matching for VEVENT/VTODO components (RFC 4791 §9.9).
 */
function matchesTimeRange(
	icsData: string,
	componentName: string,
	tr: TimeRange,
): boolean {
	const start = tr.start ? parseIcsDate(tr.start) : null;
	const end = tr.end ? parseIcsDate(tr.end) : null;

	if (componentName === "VEVENT") {
		return matchesVeventTimeRange(icsData, start, end);
	}
	if (componentName === "VTODO") {
		return matchesVtodoTimeRange(icsData, start, end);
	}

	return true;
}

function matchesVeventTimeRange(
	icsData: string,
	start: number | null,
	end: number | null,
): boolean {
	const dtstart = extractComponentProp(icsData, "VEVENT", "DTSTART");
	const dtend = extractComponentProp(icsData, "VEVENT", "DTEND");

	if (!dtstart) return true;

	const startTs = parseIcsDate(dtstart);
	const endTs = dtend ? parseIcsDate(dtend) : startTs;

	if (end !== null && startTs >= end) return false;
	if (start !== null && endTs <= start) return false;
	return true;
}

function matchesVtodoTimeRange(
	icsData: string,
	start: number | null,
	end: number | null,
): boolean {
	const dtstart = extractComponentProp(icsData, "VTODO", "DTSTART");
	const due = extractComponentProp(icsData, "VTODO", "DUE");
	const completed = extractComponentProp(icsData, "VTODO", "COMPLETED");
	const created = extractComponentProp(icsData, "VTODO", "CREATED");

	if (dtstart && due) {
		const s = parseIcsDate(dtstart);
		const e = parseIcsDate(due);
		if (end !== null && s >= end) return false;
		if (start !== null && e <= start) return false;
		return true;
	}
	if (dtstart) {
		const s = parseIcsDate(dtstart);
		if (end !== null && s >= end) return false;
		return true;
	}
	if (due) {
		const d = parseIcsDate(due);
		if (start !== null && d <= start) return false;
		if (end !== null && d > end) return false;
		return true;
	}
	if (completed && created) {
		const c = parseIcsDate(completed);
		const cr = parseIcsDate(created);
		if (end !== null && cr >= end) return false;
		if (start !== null && c <= start) return false;
		return true;
	}
	if (completed) {
		// RFC 4791 §9.9: VTODO with only COMPLETED → effective range is COMPLETED
		const c = parseIcsDate(completed);
		if (end !== null && c >= end) return false;
		if (start !== null && c < start) return false;
		return true;
	}

	// No temporal properties — always matches
	return true;
}

function matchesPropertyTimeRange(
	propValue: string,
	tr: TimeRange,
): boolean {
	const ts = parseIcsDate(propValue);
	const start = tr.start ? parseIcsDate(tr.start) : null;
	const end = tr.end ? parseIcsDate(tr.end) : null;

	if (start !== null && ts < start) return false;
	if (end !== null && ts >= end) return false;
	return true;
}

/**
 * Parse ICS date/datetime to timestamp (milliseconds).
 * Handles: 20260315T100000Z, 20260315T100000, 20260315
 */
function parseIcsDate(value: string): number {
	const clean = value.trim().replace(/Z$/i, "");
	if (clean.length === 8) {
		const y = parseInt(clean.slice(0, 4), 10);
		const m = parseInt(clean.slice(4, 6), 10) - 1;
		const d = parseInt(clean.slice(6, 8), 10);
		return Date.UTC(y, m, d);
	}
	const y = parseInt(clean.slice(0, 4), 10);
	const m = parseInt(clean.slice(4, 6), 10) - 1;
	const d = parseInt(clean.slice(6, 8), 10);
	const h = parseInt(clean.slice(9, 11), 10);
	const min = parseInt(clean.slice(11, 13), 10);
	const s = parseInt(clean.slice(13, 15), 10);
	return Date.UTC(y, m, d, h, min, s);
}
