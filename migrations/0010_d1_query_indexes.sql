-- Phase 6a: D1 クエリ最適化インデックス

-- 1. calendar_objects: Duplicate UID チェック高速化
CREATE INDEX IF NOT EXISTS idx_calendar_objects_calendar_uid
  ON calendar_objects (calendar_id, uid);

-- 2. calendarchanges: sync-collection (WHERE calendar_id = ? AND synctoken >= ?) 高速化
CREATE INDEX IF NOT EXISTS idx_calendarchanges_calendar_synctoken
  ON calendarchanges (calendar_id, synctoken);

-- 3. calendar_objects: PROPFIND / REPORT (WHERE calendar_id = ?) 高速化
CREATE INDEX IF NOT EXISTS idx_calendar_objects_calendar_id
  ON calendar_objects (calendar_id);

-- 4. calendar_shares: 共有カレンダー一覧取得 (WHERE shared_with = ?) 高速化
CREATE INDEX IF NOT EXISTS idx_calendar_shares_shared_with
  ON calendar_shares (shared_with);
