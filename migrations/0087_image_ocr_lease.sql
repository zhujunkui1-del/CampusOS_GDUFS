-- A single global OCR lease. The per-row lease is not enough: overlapping
-- scheduled invocations can each observe no active row before either writes,
-- so the monthly/daily budget row also carries a short exclusive lease.
ALTER TABLE image_ocr_budget ADD COLUMN lease_until_ms INTEGER NOT NULL DEFAULT 0;
