-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Add idempotency_key column and UNIQUE index for booking deduplication
-- Purpose: Prevent duplicate bookings from VAPI retries, double-clicks, network failures
-- Safety: Partial unique index allows NULL for legacy bookings
-- ─────────────────────────────────────────────────────────────────────────────

-- Step 1: Add idempotency_key column if it doesn't exist
ALTER TABLE bookings
ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(64);

-- Step 2: Create partial unique index (handles NULL gracefully)
-- This index is partial: only enforces uniqueness when idempotency_key IS NOT NULL
-- Allows multiple NULL values (legacy bookings before this migration)
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_idempotency_key
ON bookings(restaurant_id, idempotency_key)
WHERE idempotency_key IS NOT NULL;

-- Step 3: Verify index creation
-- (Run this separately to confirm: SELECT * FROM pg_indexes WHERE tablename='bookings' AND indexname='idx_bookings_idempotency_key';)

-- ─────────────────────────────────────────────────────────────────────────────
-- Data Integrity Guarantees:
-- ✓ Duplicate bookings with same key will fail at DB level (23505 error)
-- ✓ Application catches 23505 and returns existing booking
-- ✓ Backward compatible: NULL idempotency_key for existing bookings
-- ✓ No data loss: legacy bookings unaffected
-- ─────────────────────────────────────────────────────────────────────────────
