-- calendars (projects)
CREATE TABLE IF NOT EXISTS calendars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  component_type TEXT NOT NULL,
  ctag TEXT NOT NULL DEFAULT '0',
  synctoken INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_calendars_user_id ON calendars(user_id);

-- calendar objects (VTODO/VEVENT items stored as raw ICS)
CREATE TABLE IF NOT EXISTS calendar_objects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  calendar_id INTEGER NOT NULL REFERENCES calendars(id),
  uid TEXT NOT NULL,
  etag TEXT NOT NULL,
  ics_data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(calendar_id, uid)
);

CREATE INDEX IF NOT EXISTS idx_calendar_objects_calendar_id ON calendar_objects(calendar_id);

-- change log for sync-collection (Sabre/Nextcloud style)
CREATE TABLE IF NOT EXISTS calendarchanges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  calendar_id INTEGER NOT NULL REFERENCES calendars(id),
  uri TEXT NOT NULL,
  synctoken INTEGER NOT NULL,
  operation INTEGER NOT NULL  -- 1=add, 2=update, 3=delete
);

CREATE INDEX IF NOT EXISTS idx_calendarchanges_calendar_synctoken ON calendarchanges(calendar_id, synctoken);
