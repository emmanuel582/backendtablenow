-- Calendar OAuth hardening: Add calendar status tracking
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS calendar_status VARCHAR(50) DEFAULT 'pending';
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS calendar_provider VARCHAR(50) DEFAULT NULL;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS calendar_skipped_at TIMESTAMP NULL;

CREATE INDEX IF NOT EXISTS idx_restaurants_calendar_status
ON restaurants(calendar_status);
