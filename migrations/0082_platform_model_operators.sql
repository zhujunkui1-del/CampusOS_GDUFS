-- The owner named the accounts that may change the platform model chain:
-- console admins, plus admin01 and owner / owner@example.com.
-- The application side reads the same list from PLATFORM_MODEL_OPERATORS
-- (comma separated, mailbox name or full address); this trigger is the
-- last line of defence, so the two must name the same people.
DROP TRIGGER console_platform_models_insert;
CREATE TRIGGER console_platform_models_insert BEFORE INSERT ON console_commands
WHEN NEW.action='platform.models' BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM console_admins a WHERE a.id=NEW.admin_id AND a.status='active' AND (
   a.role='admin'
   OR lower(a.email)='owner@example.com'
   OR lower(substr(a.email,1,instr(a.email,'@')-1)) IN ('owner','admin01')
  )
 ) THEN RAISE(ABORT,'CONSOLE_DENIED') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM console_engine_settings WHERE id=NEW.target_id AND version=NEW.expected_version) THEN RAISE(ABORT,'CONSOLE_STALE') END;
END;
