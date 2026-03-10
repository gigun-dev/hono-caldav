import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	sendImipEmail,
	sendItipRequestToAttendees,
} from "../src/scheduling/email-sender.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
	mockFetch.mockReset();
});

describe("sendImipEmail", () => {
	it("sends email via Resend API with correct headers and body", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(JSON.stringify({ id: "email-123" }), { status: 200 }),
		);

		const result = await sendImipEmail("re_test_key", {
			from: "scheduling@test.com",
			to: "alice@test.com",
			subject: "Invitation: Team Meeting",
			icsData: "BEGIN:VCALENDAR\r\nEND:VCALENDAR",
			method: "REQUEST",
		});

		expect(result.success).toBe(true);
		expect(result.id).toBe("email-123");

		expect(mockFetch).toHaveBeenCalledOnce();
		const [url, options] = mockFetch.mock.calls[0];
		expect(url).toBe("https://api.resend.com/emails");
		expect(options.method).toBe("POST");
		expect(options.headers.Authorization).toBe("Bearer re_test_key");
		expect(options.headers["Content-Type"]).toBe("application/json");

		const body = JSON.parse(options.body);
		expect(body.from).toBe("scheduling@test.com");
		expect(body.to).toEqual(["alice@test.com"]);
		expect(body.subject).toBe("Invitation: Team Meeting");
		expect(body.attachments).toHaveLength(1);
		expect(body.attachments[0].filename).toBe("invite.ics");
		expect(body.attachments[0].content_type).toContain("text/calendar");
		expect(body.attachments[0].content_type).toContain("method=REQUEST");
	});

	it("returns error on Resend API failure", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response("Rate limit exceeded", { status: 429 }),
		);

		const result = await sendImipEmail("re_test_key", {
			from: "scheduling@test.com",
			to: "alice@test.com",
			subject: "Invitation: Meeting",
			icsData: "BEGIN:VCALENDAR\r\nEND:VCALENDAR",
			method: "REQUEST",
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain("429");
		expect(result.error).toContain("Rate limit exceeded");
	});
});

describe("sendItipRequestToAttendees", () => {
	it("sends emails to all attendees", async () => {
		mockFetch
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: "email-1" }), { status: 200 }),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: "email-2" }), { status: 200 }),
			);

		const results = await sendItipRequestToAttendees(
			"re_test_key",
			"scheduling@test.com",
			"Team Standup",
			"BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR",
			["alice@test.com", "bob@test.com"],
		);

		expect(results).toHaveLength(2);
		expect(results[0].success).toBe(true);
		expect(results[1].success).toBe(true);
		expect(mockFetch).toHaveBeenCalledTimes(2);

		// Verify subjects
		const body1 = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(body1.subject).toBe("Invitation: Team Standup");
		expect(body1.to).toEqual(["alice@test.com"]);

		const body2 = JSON.parse(mockFetch.mock.calls[1][1].body);
		expect(body2.to).toEqual(["bob@test.com"]);
	});

	it("handles partial failures", async () => {
		mockFetch
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: "email-1" }), { status: 200 }),
			)
			.mockResolvedValueOnce(
				new Response("Server error", { status: 500 }),
			);

		const results = await sendItipRequestToAttendees(
			"re_test_key",
			"scheduling@test.com",
			"Meeting",
			"BEGIN:VCALENDAR\r\nEND:VCALENDAR",
			["alice@test.com", "bob@test.com"],
		);

		expect(results).toHaveLength(2);
		expect(results[0].success).toBe(true);
		expect(results[1].success).toBe(false);
		expect(results[1].error).toContain("500");
	});
});
