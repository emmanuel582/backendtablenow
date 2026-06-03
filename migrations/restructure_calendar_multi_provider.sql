-- Restructure calendar storage: TableNow (bookings) is the source of truth.
-- Push to any number of external calendars, plus a universal subscribable ICS feed.
--
-- Replaces the legacy single-column model:
--   restaurants.google_calendar_tokens  (one Google account)
--   restaurants.calendar_provider       (one provider)
--   bookings.calendar_event_id          (one external event per booking)
-- with:
--   restaurants.calendar_feed_token     (universal ICS feed)
--   calendar_connections                (N push targets per restaurant)
--   calendar_event_links                (one booking -> N external events)

-- 1. Universal ICS feed token (works with Google, Apple, Outlook, anything that subscribes)
ALTER TABLE restaurants
    ADD COLUMN IF NOT EXISTS calendar_feed_token text;

UPDATE restaurants
SET calendar_feed_token = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
WHERE calendar_feed_token IS NULL;

ALTER TABLE restaurants
    ALTER COLUMN calendar_feed_token SET DEFAULT replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

ALTER TABLE restaurants
    ALTER COLUMN calendar_feed_token SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_restaurants_calendar_feed_token
    ON restaurants (calendar_feed_token);

-- 2. Push connections — one row per external calendar a restaurant pushes to
CREATE TABLE IF NOT EXISTS calendar_connections (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id  uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    provider       text NOT NULL,                       -- 'google' (pluggable: 'microsoft', ...)
    account_email  text,                                -- account that owns the calendar
    calendar_id    text NOT NULL DEFAULT 'primary',
    tokens         jsonb NOT NULL,                      -- OAuth tokens (access/refresh/expiry)
    status         text NOT NULL DEFAULT 'active',      -- 'active' | 'error' | 'revoked'
    sync_enabled   boolean NOT NULL DEFAULT true,
    last_synced_at timestamptz,
    last_error     text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_calendar_connections_restaurant
    ON calendar_connections (restaurant_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_calendar_connections_target
    ON calendar_connections (restaurant_id, provider, COALESCE(account_email, ''), calendar_id);

-- 3. Booking -> external event links (one booking can map to many external events)
CREATE TABLE IF NOT EXISTS calendar_event_links (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id         uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    connection_id      uuid NOT NULL REFERENCES calendar_connections(id) ON DELETE CASCADE,
    provider           text NOT NULL,
    external_event_id  text NOT NULL,
    external_event_url text,
    status             text NOT NULL DEFAULT 'active',  -- 'active' | 'cancelled' | 'error'
    last_error         text,
    synced_at          timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_calendar_event_links_booking
    ON calendar_event_links (booking_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_calendar_event_links_booking_connection
    ON calendar_event_links (booking_id, connection_id);

-- 4. Backfill: existing Google tokens -> one connection per restaurant
INSERT INTO calendar_connections (restaurant_id, provider, tokens, status)
SELECT id, 'google', google_calendar_tokens::jsonb, 'active'
FROM restaurants
WHERE google_calendar_tokens IS NOT NULL
  AND btrim(google_calendar_tokens) <> ''
ON CONFLICT DO NOTHING;

-- 5. Backfill: existing per-booking event ids -> links (matched to the Google connection)
INSERT INTO calendar_event_links (booking_id, connection_id, provider, external_event_id)
SELECT b.id, c.id, 'google', b.calendar_event_id
FROM bookings b
JOIN calendar_connections c
  ON c.restaurant_id = b.restaurant_id AND c.provider = 'google'
WHERE b.calendar_event_id IS NOT NULL
  AND btrim(b.calendar_event_id) <> ''
ON CONFLICT DO NOTHING;

-- 6. RLS on (service role bypasses; no public policies — backend-only access)
ALTER TABLE calendar_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_event_links ENABLE ROW LEVEL SECURITY;

-- 7. Drop the legacy single-value columns now that data is migrated
ALTER TABLE restaurants DROP COLUMN IF EXISTS google_calendar_tokens;
ALTER TABLE restaurants DROP COLUMN IF EXISTS calendar_provider;
ALTER TABLE bookings    DROP COLUMN IF EXISTS calendar_event_id;
