CREATE TABLE scheduling_feedback (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	calendar_object_id INTEGER NOT NULL REFERENCES calendar_objects(id) ON DELETE CASCADE,
	attendee_email TEXT NOT NULL,
	feedback_type TEXT NOT NULL,
	original_dtstart TEXT,
	original_dtend TEXT,
	proposed_dtstart TEXT,
	proposed_dtend TEXT,
	created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_feedback_object ON scheduling_feedback(calendar_object_id);
