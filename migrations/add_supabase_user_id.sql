-- Add Supabase user_id mapping to restaurants table
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS supabase_user_id UUID UNIQUE NULL;

-- Create index for fast lookups
CREATE INDEX IF NOT EXISTS idx_restaurants_supabase_user_id
ON restaurants(supabase_user_id);
