/**
 * Generate an unsigned iOS mobileconfig plist for CalDAV account setup.
 * The password field is omitted so the user is prompted at install time.
 */
export function generateMobileconfig(
	hostname: string,
	username: string,
	accountDescription: string = "CalDAV Task Manager",
): string {
	const profileUUID = crypto.randomUUID().toUpperCase();
	const payloadUUID = crypto.randomUUID().toUpperCase();
	const port = 443;

	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>CalDAVAccountDescription</key>
      <string>${escapeXml(accountDescription)}</string>
      <key>CalDAVHostName</key>
      <string>${escapeXml(hostname)}</string>
      <key>CalDAVPort</key>
      <integer>${port}</integer>
      <key>CalDAVPrincipalURL</key>
      <string>/dav/principals/${escapeXml(username)}/</string>
      <key>CalDAVUseSSL</key>
      <true/>
      <key>CalDAVUsername</key>
      <string>${escapeXml(username)}</string>
      <key>PayloadDescription</key>
      <string>CalDAV Account Configuration</string>
      <key>PayloadDisplayName</key>
      <string>${escapeXml(accountDescription)}</string>
      <key>PayloadIdentifier</key>
      <string>com.hono-caldav.account</string>
      <key>PayloadType</key>
      <string>com.apple.caldav.account</string>
      <key>PayloadUUID</key>
      <string>${payloadUUID}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key>
  <string>CalDAV Server Configuration Profile</string>
  <key>PayloadDisplayName</key>
  <string>${escapeXml(accountDescription)}</string>
  <key>PayloadIdentifier</key>
  <string>com.hono-caldav.profile</string>
  <key>PayloadOrganization</key>
  <string>hono-caldav</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${profileUUID}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>`;
}

function escapeXml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
