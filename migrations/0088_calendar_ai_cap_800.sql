-- The original calendar_ai_cap column has a CHECK ceiling of 400, which SQLite
-- cannot alter in place. Keep that column for existing operator settings and
-- add an explicit override for the higher daily budget.
ALTER TABLE console_engine_settings ADD COLUMN calendar_ai_cap_override INTEGER CHECK(calendar_ai_cap_override IS NULL OR calendar_ai_cap_override BETWEEN 1 AND 800);
UPDATE console_engine_settings SET calendar_ai_cap_override=800 WHERE id='console-v2-settings';
