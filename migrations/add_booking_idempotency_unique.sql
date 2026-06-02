-- Booking idempotency hardening
-- ---------------------------------------------------------------------------
-- Today, duplicate-booking protection on VAPI retries is enforced in
-- application code only (booking.service.ts: SELECT on call_id, then INSERT).
-- Two concurrent retries can both pass the SELECT before either INSERTs,
-- producing a double booking. This migration backs the code-level check with
-- a database-level guarantee via a partial UNIQUE index on (restaurant_id,
-- call_id). The matching code path (booking.service.ts) already recovers the
-- existing row on a 23505 unique-violation, so this change is behaviour-safe.
--
-- NOTE: call_id is the de-facto idempotency key used by the code. The separate
-- `idempotency_key` column is currently UNUSED by the application — do NOT
-- delete or repurpose it here; that is a later, deliberate decision.
-- ---------------------------------------------------------------------------

-- STEP 1 — PRE-FLIGHT CHECK (run this FIRST, separately).
-- The UNIQUE index will FAIL to create if duplicates already exist.
-- This query must return ZERO rows before applying STEP 2.
--
--   SELECT restaurant_id, call_id, COUNT(*) AS dupes
--   FROM bookings
--   WHERE call_id IS NOT NULL
--   GROUP BY restaurant_id, call_id
--   HAVING COUNT(*) > 1
--   ORDER BY dupes DESC;
--
-- If it returns rows, resolve those duplicates manually before continuing.

-- STEP 2 — Create the partial unique index (additive, no behaviour change).
-- Partial (WHERE call_id IS NOT NULL) so manual/web bookings without an
-- idempotency key are unaffected and can coexist freely.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_bookings_restaurant_call_id
ON bookings (restaurant_id, call_id)
WHERE call_id IS NOT NULL;
