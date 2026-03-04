/**
 * Minimal ICS utilities.
 * ICS data is stored as-is; these helpers extract metadata when needed.
 * ical.js is kept for future extensibility (e.g. BFF layer, metadata extraction).
 */
import ICAL from "ical.js";

/**
 * Extract UID from raw ICS data.
 * Falls back to regex if ical.js parsing fails.
 */
export function extractUid(ics: string): string | null {
	try {
		const jcal = ICAL.parse(ics);
		const component = new ICAL.Component(jcal);
		const vtodo = component.getFirstSubcomponent("vtodo");
		if (vtodo) {
			const uid = vtodo.getFirstPropertyValue("uid");
			if (uid) return String(uid);
		}
		const vevent = component.getFirstSubcomponent("vevent");
		if (vevent) {
			const uid = vevent.getFirstPropertyValue("uid");
			if (uid) return String(uid);
		}
	} catch {
		// fall through to regex
	}

	// Regex fallback
	const match = ics.match(/^UID:(.+)$/im);
	return match?.[1]?.trim() ?? null;
}

/**
 * Validate that ICS data contains the expected component type (VTODO or VEVENT).
 */
export function isValidComponent(ics: string, componentType: string): boolean {
	try {
		const jcal = ICAL.parse(ics);
		const component = new ICAL.Component(jcal);
		return (
			component.getFirstSubcomponent(componentType.toLowerCase()) !== null
		);
	} catch {
		return false;
	}
}
