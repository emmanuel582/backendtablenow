-- Add calendar_status to track Calendar integration state
-- Values: pending | connected | skipped | error

ALTER TABLE restaurants
ADD COLUMN IF NOT EXISTS calendar_status VARCHAR(50) DEFAULT 'pending';

CREATE INDEX IF NOT EXISTS idx_restaurants_calendar_status
ON restaurants(calendar_status);
