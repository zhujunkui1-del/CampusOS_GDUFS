-- Reopening a paused source is an operator decision, not a new verification.
-- Keep archived sources closed, but do not require a second review pass just
-- because the source was previously paused (operating_status='closed').
DROP TRIGGER IF EXISTS console_source_enable_guard;
CREATE TRIGGER console_source_enable_guard BEFORE UPDATE ON knowledge_sources
WHEN NEW.console_managed=1 AND NEW.enabled=1
BEGIN
 SELECT CASE WHEN NEW.archived_at IS NOT NULL THEN RAISE(ABORT,'CONSOLE_SOURCE_NOT_READY') END;
END;

DROP TRIGGER IF EXISTS console_v2_command_guard;
CREATE TRIGGER console_v2_command_guard BEFORE INSERT ON console_commands
WHEN json_extract(NEW.details_json,'$.v2')=1
BEGIN
 SELECT CASE WHEN NEW.action='engine.settings' AND (SELECT role FROM console_admins WHERE id=NEW.admin_id)<>'admin' THEN RAISE(ABORT,'CONSOLE_DENIED') END;
 SELECT CASE WHEN NEW.action='engine.settings' AND NOT EXISTS(SELECT 1 FROM console_engine_settings WHERE id=NEW.target_id AND version=NEW.expected_version) THEN RAISE(ABORT,'CONSOLE_STALE') END;
 SELECT CASE WHEN NEW.action IN('job.create','job.claim','job.commit','document.publish') AND NOT EXISTS(SELECT 1 FROM knowledge_sources WHERE id=COALESCE(NEW.source_id,(SELECT source_id FROM knowledge_documents WHERE id=NEW.target_id)) AND enabled=1 AND archived_at IS NULL AND operating_status<>'closed' AND sync_state<>'blocked') THEN RAISE(ABORT,'CONSOLE_SOURCE_NOT_READY') END;
 SELECT CASE WHEN NEW.action='document.review' AND (SELECT role FROM console_admins WHERE id=NEW.admin_id) NOT IN('admin','reviewer') THEN RAISE(ABORT,'CONSOLE_DENIED') END;
END;
