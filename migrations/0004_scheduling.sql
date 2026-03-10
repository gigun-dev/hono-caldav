-- Attendee tracking for iTIP/iMIP scheduling
CREATE TABLE IF NOT EXISTS attendees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  calendar_object_id INTEGER NOT NULL REFERENCES calendar_objects(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  partstat TEXT NOT NULL DEFAULT 'NEEDS-ACTION',
  rsvp INTEGER NOT NULL DEFAULT 1,
  sent_at TEXT,
  replied_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_attendees_object ON attendees(calendar_object_id);
CREATE INDEX IF NOT EXISTS idx_attendees_email ON attendees(email);
