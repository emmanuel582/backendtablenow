-- Booking Stability: Idempotency + Outbox Pattern
-- Non-negotiable for production reliability

-- 1. Add idempotency_key UNIQUE NOT NULL to bookings
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Backfill NULL values with UUIDs to ensure all rows have a key before adding NOT NULL
UPDATE bookings SET idempotency_key = gen_random_uuid()::TEXT WHERE idempotency_key IS NULL;

-- Add NOT NULL + UNIQUE constraint (non-deferrable for immediate enforcement)
ALTER TABLE bookings ALTER COLUMN idempotency_key SET NOT NULL;
ALTER TABLE bookings ADD CONSTRAINT bookings_idempotency_key_unique UNIQUE (idempotency_key);

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

-- Atomic claim function (concurrency-safe via FOR UPDATE SKIP LOCKED)
CREATE OR REPLACE FUNCTION claim_outbox_events(batch_size INT DEFAULT 10)
RETURNS TABLE (
  id UUID,
  booking_id UUID,
  restaurant_id UUID,
  channel TEXT,
  dedupe_key TEXT,
  attempts INT,
  max_attempts INT,
  correlation_id TEXT,
  created_at TIMESTAMP,
  updated_at TIMESTAMP
) AS $$
BEGIN
  RETURN QUERY
  UPDATE outbox_events
  SET status = 'claimed', updated_at = NOW()
  WHERE id IN (
    SELECT id FROM outbox_events
    WHERE status = 'pending'
      AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
    ORDER BY created_at ASC
    LIMIT batch_size
    FOR UPDATE SKIP LOCKED
  )
  RETURNING
    outbox_events.id,
    outbox_events.booking_id,
    outbox_events.restaurant_id,
    outbox_events.channel,
    outbox_events.dedupe_key,
    outbox_events.attempts,
    outbox_events.max_attempts,
    outbox_events.correlation_id,
    outbox_events.created_at,
    outbox_events.updated_at;
END;
$$ LANGUAGE plpgsql;
