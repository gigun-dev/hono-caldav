import { describe, it, expect } from "vitest";
import { generateMobileconfig } from "../src/setup/mobileconfig.js";

describe("mobileconfig generation", () => {
	it("generates valid plist XML", () => {
		const xml = generateMobileconfig("caldav.example.com", "alice@example.com");

		expect(xml).toContain('<?xml version="1.0"');
		expect(xml).toContain("<plist version=");
		expect(xml).toContain("com.apple.caldav.account");
	});

	it("includes hostname and username", () => {
		const xml = generateMobileconfig("my-server.dev", "bob@test.com");

		expect(xml).toContain("<string>my-server.dev</string>");
		expect(xml).toContain("<string>bob@test.com</string>");
		expect(xml).toContain("/dav/principals/bob@test.com/");
	});

	it("uses SSL on port 443", () => {
		const xml = generateMobileconfig("host.com", "user@host.com");

		expect(xml).toContain("<true/>");
		expect(xml).toContain("<integer>443</integer>");
	});

	it("includes default account description", () => {
		const xml = generateMobileconfig("host.com", "user@host.com");

		expect(xml).toContain("CalDAV Task Manager");
	});

	it("uses custom account description", () => {
		const xml = generateMobileconfig("host.com", "user@host.com", "My Custom Account");

		expect(xml).toContain("My Custom Account");
		expect(xml).not.toContain("CalDAV Task Manager");
	});

	it("escapes XML special characters in username", () => {
		const xml = generateMobileconfig("host.com", "user<script>&test");

		expect(xml).toContain("user&lt;script&gt;&amp;test");
		expect(xml).not.toContain("<script>");
	});

	it("escapes XML special characters in hostname", () => {
		const xml = generateMobileconfig("host.com\"><evil", "user@test.com");

		expect(xml).toContain("host.com&quot;&gt;&lt;evil");
	});

	it("generates unique UUIDs", () => {
		const xml1 = generateMobileconfig("host.com", "user@test.com");
		const xml2 = generateMobileconfig("host.com", "user@test.com");

		// Extract UUIDs from both
		const uuids1 = xml1.match(/[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}/g);
		const uuids2 = xml2.match(/[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}/g);

		expect(uuids1).not.toBeNull();
		expect(uuids1!.length).toBe(2); // profileUUID + payloadUUID
		// Different generations should have different UUIDs
		expect(uuids1![0]).not.toBe(uuids2![0]);
	});

	it("contains required payload keys", () => {
		const xml = generateMobileconfig("host.com", "user@test.com");

		expect(xml).toContain("PayloadType");
		expect(xml).toContain("PayloadUUID");
		expect(xml).toContain("PayloadVersion");
		expect(xml).toContain("PayloadIdentifier");
		expect(xml).toContain("CalDAVHostName");
		expect(xml).toContain("CalDAVPort");
		expect(xml).toContain("CalDAVPrincipalURL");
		expect(xml).toContain("CalDAVUseSSL");
		expect(xml).toContain("CalDAVUsername");
	});
});
