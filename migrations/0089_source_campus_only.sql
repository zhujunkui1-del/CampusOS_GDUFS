ALTER TABLE knowledge_sources ADD COLUMN campus_only INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS knowledge_sources_campus_only ON knowledge_sources(campus_only) WHERE campus_only=1;
