-- Article images and async OCR/vision results.
-- Rows are bound to exactly one document and one content revision. Image text
-- is never merged across articles.
CREATE TABLE IF NOT EXISTS article_images (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  content_revision INTEGER NOT NULL,
  input_hash TEXT NOT NULL,
  url TEXT NOT NULL,
  locator TEXT NOT NULL,
  mime TEXT,
  width INTEGER,
  height INTEGER,
  digest TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','processing','ready','failed','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
  lease_until_ms INTEGER NOT NULL DEFAULT 0,
  ocr_text TEXT,
  structured_json TEXT,
  conflicts_json TEXT,
  model TEXT,
  model_version TEXT,
  error_code TEXT,
  deduped_from TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(document_id, url)
);
CREATE INDEX IF NOT EXISTS article_images_queue
  ON article_images(status, next_attempt_at_ms, lease_until_ms);
CREATE INDEX IF NOT EXISTS article_images_document
  ON article_images(document_id, status);
CREATE INDEX IF NOT EXISTS article_images_digest
  ON article_images(digest, status);

CREATE TABLE IF NOT EXISTS image_ocr_budget (
  day TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0
);

CREATE VIRTUAL TABLE IF NOT EXISTS article_image_fts USING fts5(
  image_id UNINDEXED,
  document_id UNINDEXED,
  body_terms,
  tokenize='unicode61',
  detail='column'
);
