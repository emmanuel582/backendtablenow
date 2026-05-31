-- ============================================================================
-- Booking Stability: Idempotency + Transactional Outbox Pattern
-- ============================================================================
-- Idempotent / replayable migration. Safe to run multiple times.
-- Provides:
--   1. bookings.idempotency_key NOT NULL + UNIQUE (non-deferrable)
--   2. outbox_events table with strict CHECK constraints + lease columns
--   3. create_booking_with_outbox(): transactional booking + outbox in ONE tx
--   4. claim_outbox_events(): concurrency-safe claim w/ lease recovery + retries
--   5. RPC security: search_path pinned, public access revoked
-- ============================================================================

-- ─── 1. bookings.idempotency_key (idempotent) ───────────────────────────────

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Backfill existing rows WITHOUT a key (never overwrite an existing key)
UPDATE bookings
  SET idempotency_key = gen_random_uuid()::TEXT
  WHERE idempotency_key IS NULL;

-- Enforce NOT NULL (no-op if already set)
ALTER TABLE bookings ALTER COLUMN idempotency_key SET NOT NULL;

-- Add UNIQUE constraint only if it does not already exist (replayable)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bookings_idempotency_key_unique'
      AND conrelid = 'bookings'::regclass
  ) THEN
    ALTER TABLE bookings
      ADD CONSTRAINT bookings_idempotency_key_unique UNIQUE (idempotency_key);
  END IF;
END $$;

-- ─── 2. outbox_events table (idempotent, strict constraints) ─────────────────

CREATE TABLE IF NOT EXISTS outbox_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id      UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    channel         TEXT NOT NULL,
    dedupe_key      TEXT NOT NULL UNIQUE,
    status          TEXT NOT NULL DEFAULT 'pending',
    attempts        INT  NOT NULL DEFAULT 0,
    max_attempts    INT  NOT NULL DEFAULT 3,
    claimed_at      TIMESTAMPTZ,
    claimed_by      TEXT,
    next_attempt_at TIMESTAMPTZ,
    last_error      TEXT,
    correlation_id  TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add columns / constraints for tables that already existed before this rev
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS claimed_at      TIMESTAMPTZ;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS claimed_by      TEXT;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;

-- status CHECK constraint (replayable)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'outbox_events_status_check'
      AND conrelid = 'outbox_events'::regclass
  ) THEN
    ALTER TABLE outbox_events
      ADD CONSTRAINT outbox_events_status_check
      CHECK (status IN ('pending', 'claimed', 'done', 'failed'));
  END IF;
END $$;

-- channel CHECK constraint (replayable)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'outbox_events_channel_check'
      AND conrelid = 'outbox_events'::regclass
  ) THEN
    ALTER TABLE outbox_events
      ADD CONSTRAINT outbox_events_channel_check
      CHECK (channel IN ('email', 'calendar'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON outbox_events(status, next_attempt_at)
  WHERE status IN ('pending', 'claimed');

-- ─── Auto-update updated_at trigger ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_outbox_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS outbox_updated_at ON outbox_events;
CREATE TRIGGER outbox_updated_at BEFORE UPDATE ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION update_outbox_updated_at();

-- ─── 3. create_booking_with_outbox(): atomic booking + outbox ────────────────
-- One PostgreSQL transaction: idempotency check → customer upsert → booking
-- insert → outbox events insert. Either everything commits or nothing does.

CREATE OR REPLACE FUNCTION create_booking_with_outbox(
  p_restaurant_id    UUID,
  p_idempotency_key  TEXT,
  p_booking_date     DATE,
  p_booking_time     TIME,
  p_covers           INT,
  p_guest_name       TEXT,
  p_guest_email      TEXT,
  p_guest_phone      TEXT,
  p_special_requests TEXT,
  p_source           TEXT,
  p_guest_language   TEXT,
  p_correlation_id   TEXT,
  p_channels         TEXT[]   -- e.g. ARRAY['email','calendar']
)
RETURNS TABLE (
  booking_id         UUID,
  side_effects_status TEXT,
  is_existing        BOOLEAN
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_existing_id  UUID;
  v_customer_id  UUID;
  v_booking_id   UUID;
  v_channel      TEXT;
  v_booked_for   TIMESTAMPTZ;
BEGIN
  -- Validate idempotency key
  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
    RAISE EXCEPTION 'idempotency_key is required'
      USING ERRCODE = 'check_violation';
  END IF;

  -- 1. Idempotency check — return existing booking if key already used
  SELECT id INTO v_existing_id
    FROM bookings
    WHERE idempotency_key = p_idempotency_key;

  IF v_existing_id IS NOT NULL THEN
    booking_id := v_existing_id;
    side_effects_status := 'pending';
    is_existing := TRUE;
    RETURN NEXT;
    RETURN;
  END IF;

  -- 2. Upsert customer (only if phone provided)
  IF p_guest_phone IS NOT NULL AND length(trim(p_guest_phone)) > 0 THEN
    SELECT id INTO v_customer_id
      FROM customers
      WHERE restaurant_id = p_restaurant_id AND phone = p_guest_phone;

    IF v_customer_id IS NULL THEN
      INSERT INTO customers (restaurant_id, phone, name, email)
        VALUES (p_restaurant_id, p_guest_phone, p_guest_name, p_guest_email)
        RETURNING id INTO v_customer_id;
    END IF;
  END IF;

  v_booked_for := (p_booking_date::TEXT || 'T' || p_booking_time::TEXT)::TIMESTAMPTZ;

  -- 3. Insert booking
  INSERT INTO bookings (
    restaurant_id, customer_id,
    booking_date, booking_time, party_size,
    guest_name, guest_email, guest_phone,
    booked_for, covers, special_requests,
    source, status, call_id, idempotency_key, guest_language
  ) VALUES (
    p_restaurant_id, v_customer_id,
    p_booking_date, p_booking_time, p_covers,
    p_guest_name, p_guest_email, p_guest_phone,
    v_booked_for, p_covers, p_special_requests,
    p_source, 'confirmed', p_idempotency_key, p_idempotency_key, p_guest_language
  )
  RETURNING id INTO v_booking_id;

  -- 4. Insert outbox events (minimal payload, ZERO PII)
  IF p_channels IS NOT NULL THEN
    FOREACH v_channel IN ARRAY p_channels LOOP
      INSERT INTO outbox_events (
        booking_id, restaurant_id, channel, dedupe_key,
        correlation_id, status
      ) VALUES (
        v_booking_id, p_restaurant_id, v_channel,
        'booking:' || v_booking_id::TEXT || ':' || v_channel,
        p_correlation_id, 'pending'
      );
    END LOOP;
  END IF;

  booking_id := v_booking_id;
  side_effects_status := 'pending';
  is_existing := FALSE;
  RETURN NEXT;
END;
$$;

-- ─── 4. claim_outbox_events(): concurrency-safe claim w/ lease + retries ─────
-- Claims pending events AND recovers events stuck in 'claimed' past their
-- lease. Increments attempts, sets claimed_at / claimed_by. Uses FOR UPDATE
-- SKIP LOCKED so two concurrent workers never claim the same row.

CREATE OR REPLACE FUNCTION claim_outbox_events(
  p_batch_size   INT  DEFAULT 10,
  p_worker_id    TEXT DEFAULT NULL,
  p_lease_seconds INT DEFAULT 300
)
RETURNS TABLE (
  id             UUID,
  booking_id     UUID,
  restaurant_id  UUID,
  channel        TEXT,
  dedupe_key     TEXT,
  attempts       INT,
  max_attempts   INT,
  correlation_id TEXT
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE outbox_events oe
  SET status     = 'claimed',
      attempts   = oe.attempts + 1,
      claimed_at = NOW(),
      claimed_by = COALESCE(p_worker_id, gen_random_uuid()::TEXT),
      updated_at = NOW()
  WHERE oe.id IN (
    SELECT e.id FROM outbox_events e
    WHERE (
        -- ready & pending
        (e.status = 'pending'
         AND (e.next_attempt_at IS NULL OR e.next_attempt_at <= NOW()))
        OR
        -- stuck claimed past lease (worker crashed) → recover
        (e.status = 'claimed'
         AND e.claimed_at IS NOT NULL
         AND e.claimed_at <= NOW() - make_interval(secs => p_lease_seconds))
      )
      AND e.attempts < e.max_attempts
    ORDER BY e.created_at ASC
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  RETURNING
    oe.id, oe.booking_id, oe.restaurant_id, oe.channel,
    oe.dedupe_key, oe.attempts, oe.max_attempts, oe.correlation_id;
END;
$$;

-- ─── 5. RPC security: pin search_path, revoke public, grant backend role ─────
-- search_path is already pinned via `SET search_path = public` on each fn.
-- Revoke broad execute, grant only to the backend role(s).
-- NOTE: the backend connects with the Supabase service_role (admin). The anon
-- role must NOT be able to call these functions.

REVOKE ALL ON FUNCTION create_booking_with_outbox(
  UUID, TEXT, DATE, TIME, INT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[]
) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION claim_outbox_events(INT, TEXT, INT)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION create_booking_with_outbox(
  UUID, TEXT, DATE, TIME, INT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[]
) TO service_role;

GRANT EXECUTE ON FUNCTION claim_outbox_events(INT, TEXT, INT) TO service_role;
