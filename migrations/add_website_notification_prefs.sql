-- Run on Supabase SQL editor
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS website VARCHAR(500);
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS notification_prefs JSONB DEFAULT '{"confirmation_email":true,"new_booking_alert":true,"daily_summary":false}';
