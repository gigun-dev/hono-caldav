/**
 * CalDAV calendar-query REPORT filter (RFC 4791 §7.8, §9.7).
 * Parses <c:filter> XML and matches calendar objects.
 */

import ICAL from "ical.js";
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
	const allTags: { index: number; type: "open" | "close" }[] =
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
	const caseInsensitive = tm.collation === "i;ascii-casemap" || tm.collation === "i;unicode-casemap";
	const v = caseInsensitive ? value.toLowerCase() : value;
	const target = caseInsensitive ? tm.value.toLowerCase() : tm.value;

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
	const startRaw = tr.start ? parseIcsDate(tr.start) : null;
	const endRaw = tr.end ? parseIcsDate(tr.end) : null;
	// Treat NaN (malformed date) as "no constraint"
	const start = startRaw !== null && !Number.isNaN(startRaw) ? startRaw : null;
	const end = endRaw !== null && !Number.isNaN(endRaw) ? endRaw : null;

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

	// Check if the base event itself overlaps with the range
	const baseOverlaps =
		(end === null || startTs < end) && (start === null || endTs > start);

	if (baseOverlaps) return true;

	// If no RRULE, the base event didn't match so return false
	if (!hasRRule(icsData, "VEVENT")) return false;

	// Expand recurrence and check if any occurrence falls in range
	return matchesRecurrence(icsData, "VEVENT", start, end);
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

	let baseMatches: boolean;

	if (dtstart && due) {
		const s = parseIcsDate(dtstart);
		const e = parseIcsDate(due);
		baseMatches =
			(end === null || s < end) && (start === null || e > start);
	} else if (dtstart) {
		const s = parseIcsDate(dtstart);
		baseMatches = end === null || s < end;
		// DTSTART-only: matches if filter end is after DTSTART (no start bound check for open-ended)
		if (start !== null && !due) {
			// Original logic: only checks end
			baseMatches = end === null || s < end;
		}
	} else if (due) {
		const d = parseIcsDate(due);
		baseMatches =
			(start === null || d > start) && (end === null || d < end);
	} else if (completed && created) {
		const c = parseIcsDate(completed);
		const cr = parseIcsDate(created);
		baseMatches =
			(end === null || cr < end) && (start === null || c > start);
	} else if (completed) {
		const c = parseIcsDate(completed);
		baseMatches =
			(end === null || c < end) && (start === null || c >= start);
	} else {
		// No temporal properties — always matches
		return true;
	}

	if (baseMatches) return true;

	// If no RRULE, base didn't match
	if (!hasRRule(icsData, "VTODO")) return false;

	// Expand recurrence for VTODO
	return matchesRecurrence(icsData, "VTODO", start, end);
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

// --- RRULE expansion helpers ---

/** Maximum number of occurrences to expand for RRULE matching. */
const MAX_RECURRENCE_EXPANSIONS = 1000;

/** Maximum expansion window: 2 years from DTSTART (in ms). */
const MAX_EXPANSION_WINDOW_MS = 2 * 365.25 * 24 * 60 * 60 * 1000;

/**
 * Check if a component contains an RRULE property.
 */
function hasRRule(icsData: string, componentName: string): boolean {
	return extractComponentProp(icsData, componentName, "RRULE") !== null;
}

/**
 * Expand RRULE using ical.js and check if any occurrence overlaps with the time range.
 * Falls back to conservatively returning true if ical.js fails.
 */
function matchesRecurrence(
	icsData: string,
	componentName: string,
	start: number | null,
	end: number | null,
): boolean {
	try {
		const jcal = ICAL.parse(icsData);
		const vcalendar = new ICAL.Component(jcal);
		const component = vcalendar.getFirstSubcomponent(
			componentName.toLowerCase(),
		);
		if (!component) return true; // conservative

		const dtstart = component.getFirstPropertyValue("dtstart") as ICAL.Time | null;
		if (!dtstart) return true;

		// Determine event duration for overlap calculation
		let durationMs = 0;
		if (componentName === "VEVENT") {
			const dtend = component.getFirstPropertyValue("dtend") as ICAL.Time | null;
			const duration = component.getFirstPropertyValue("duration") as ICAL.Duration | null;
			if (dtend) {
				durationMs = (dtend.toUnixTime() - dtstart.toUnixTime()) * 1000;
			} else if (duration) {
				durationMs = duration.toSeconds() * 1000;
			}
		} else if (componentName === "VTODO") {
			const due = component.getFirstPropertyValue("due") as ICAL.Time | null;
			const duration = component.getFirstPropertyValue("duration") as ICAL.Duration | null;
			if (due) {
				durationMs = (due.toUnixTime() - dtstart.toUnixTime()) * 1000;
			} else if (duration) {
				durationMs = duration.toSeconds() * 1000;
			}
		}
		if (durationMs < 0) durationMs = 0;

		// Calculate expansion limit
		const dtstartMs = dtstart.toUnixTime() * 1000;
		const expansionEnd = dtstartMs + MAX_EXPANSION_WINDOW_MS;
		// If the query end is set and within our window, use it as the limit
		const effectiveEnd = end !== null ? Math.min(end, expansionEnd) : expansionEnd;

		// Create recurrence iterator
		const recur = component.getFirstPropertyValue("rrule") as ICAL.Recur;
		if (!recur) return true;

		const iter = recur.iterator(dtstart);
		let count = 0;

		while (count < MAX_RECURRENCE_EXPANSIONS) {
			const next = iter.next();
			if (!next) break;

			const occurrenceStartMs = next.toUnixTime() * 1000;
			const occurrenceEndMs = occurrenceStartMs + durationMs;

			// Stop expanding if we've gone past the effective end
			if (occurrenceStartMs > effectiveEnd) break;

			// Check overlap: occurrence overlaps if it starts before range end
			// and ends after range start
			const overlaps =
				(end === null || occurrenceStartMs < end) &&
				(start === null || occurrenceEndMs > start);

			if (overlaps) return true;

			count++;
		}

		return false;
	} catch {
		// Conservative fallback: if ical.js fails, include the event
		return true;
	}
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
		if (isNaN(y) || isNaN(m) || isNaN(d)) return NaN;
		return Date.UTC(y, m, d);
	}
	const y = parseInt(clean.slice(0, 4), 10);
	const m = parseInt(clean.slice(4, 6), 10) - 1;
	const d = parseInt(clean.slice(6, 8), 10);
	const h = parseInt(clean.slice(9, 11), 10);
	const min = parseInt(clean.slice(11, 13), 10);
	const s = parseInt(clean.slice(13, 15), 10);
	if (isNaN(y) || isNaN(m) || isNaN(d) || isNaN(h) || isNaN(min) || isNaN(s)) return NaN;
	return Date.UTC(y, m, d, h, min, s);
}
