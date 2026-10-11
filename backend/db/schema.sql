-- FloodLens community reports schema. Idempotent: safe to run repeatedly.
CREATE TABLE IF NOT EXISTS community_reports (
  id             BIGSERIAL PRIMARY KEY,
  latitude       DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude      DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  description    TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 1000),
  location_label TEXT CHECK (location_label IS NULL OR char_length(location_label) <= 300),
  -- Always assigned by the database clock; clients cannot set it.
  submitted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Reports are never auto-verified. Expiry hides them from the active map
  -- but rows are retained for historical analysis.
  verification   TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK (verification IN ('UNVERIFIED')),
  -- Keyed HMAC of the submitter's IP (truncated). Used only to judge whether
  -- clustered reports could be independent. The raw IP is never stored.
  source_hash    TEXT
);

CREATE INDEX IF NOT EXISTS community_reports_submitted_at_idx
  ON community_reports (submitted_at DESC);
