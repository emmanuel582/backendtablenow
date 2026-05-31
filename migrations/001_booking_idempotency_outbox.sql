-- Booking Stability: Idempotency + Outbox Pattern
-- Non-negotiable for production reliability

-- 1. Add idempotency_key UNIQUE NOT NULL to bookings
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE bookings ADD CONSTRAINT bookings_idempotency_key_unique UNIQUE (idempotency_key) DEFERRABLE INITIALLY DEFERRED;

-- 2. Create outbox_events table (minimal, no PII)
CREATE TABLE IF NOT EXISTS outbox_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    channel TEXT NOT NULL, -- 'email' or 'calendar'
    dedupe_key TEXT NOT NULL UNIQUE, -- Format: booking:{id}:email or booking:{id}:calendar
    status TEXT DEFAULT 'pending', -- pending, claimed, done, failed
    attempts INT DEFAULT 0,
    max_attempts INT DEFAULT 3,
    next_attempt_at TIMESTAMP,
    last_error TEXT,
    correlation_id TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_events(status) WHERE status IN ('pending', 'claimed');
CREATE INDEX IF NOT EXISTS idx_outbox_next_attempt ON outbox_events(next_attempt_at) WHERE status != 'done';

-- Auto-update timestamp
CREATE OR REPLACE FUNCTION update_outbox_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS outbox_updated_at ON outbox_events;
CREATE TRIGGER outbox_updated_at BEFORE UPDATE ON outbox_events FOR EACH ROW EXECUTE FUNCTION update_outbox_updated_at();
