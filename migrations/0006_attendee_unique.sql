CREATE UNIQUE INDEX IF NOT EXISTS idx_attendees_unique ON attendees(calendar_object_id, email);
