-- OCR results feed the same article analysis projection as the body. The
-- projection timestamp makes a failed merge retryable without re-calling the
-- vision model.
ALTER TABLE article_images ADD COLUMN projected_at TEXT;
ALTER TABLE article_images ADD COLUMN projection_error TEXT;
CREATE INDEX IF NOT EXISTS idx_article_images_projection
  ON article_images(status, projected_at, updated_at);
