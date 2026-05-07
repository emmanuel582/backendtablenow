-- Add idempotency_key column and UNIQUE constraint for booking deduplication
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(64);

-- Create unique constraint on (restaurant_id, idempotency_key)
-- This prevents duplicate bookings from being created with the same key within a restaurant
ALTER TABLE bookings ADD CONSTRAINT bookings_restaurant_idempotency_key_unique
  UNIQUE (restaurant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Note: The constraint uses "WHERE idempotency_key IS NOT NULL" to allow NULL values
-- for legacy bookings created before idempotency was implemented
