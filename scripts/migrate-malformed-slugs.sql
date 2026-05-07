-- Migration: Fix malformed slugs created with old Date.now().toString(36) pattern
-- Issue: Old slug generation created invalid slugs like "resto-kvxkv" instead of proper names
-- Risk: Links and bookmarks to old restaurants break
-- Action: BEFORE running this script, verify no external links depend on current slugs

-- 1. Identify all malformed slugs (pattern: "resto-" followed by 5-6 hex chars)
SELECT id, name, slug, created_at
FROM restaurants
WHERE slug ~ '^resto-[a-z0-9]{5,6}$'
ORDER BY created_at;

-- 2. Generate new slugs (using existing name field)
-- This query shows the mapping of old → new slugs:
SELECT
  id,
  slug AS old_slug,
  LOWER(REGEXP_REPLACE(REGEXP_REPLACE(name, '[^\w\s-]', '', 'g'), '\s+', '-', 'g')) AS proposed_new_slug,
  name
FROM restaurants
WHERE slug ~ '^resto-[a-z0-9]{5,6}$'
ORDER BY name;

-- 3. Check for slug collisions with proposed new slugs
WITH proposed AS (
  SELECT
    id,
    LOWER(REGEXP_REPLACE(REGEXP_REPLACE(name, '[^\w\s-]', '', 'g'), '\s+', '-', 'g')) AS new_slug
  FROM restaurants
  WHERE slug ~ '^resto-[a-z0-9]{5,6}$'
)
SELECT new_slug, COUNT(*) as count
FROM proposed
GROUP BY new_slug
HAVING COUNT(*) > 1;

-- 4. If no collisions, update the slugs:
UPDATE restaurants
SET slug = LOWER(REGEXP_REPLACE(REGEXP_REPLACE(name, '[^\w\s-]', '', 'g'), '\s+', '-', 'g'))
WHERE slug ~ '^resto-[a-z0-9]{5,6}$';

-- 5. Verify the update
SELECT id, name, slug, updated_at
FROM restaurants
WHERE updated_at = NOW()::DATE
ORDER BY name;

-- 6. Log the migration in a comments table (if you have one)
-- INSERT INTO migrations (script_name, description, status)
-- VALUES ('migrate-malformed-slugs', 'Fixed slugs created with old Date.now().toString(36) pattern', 'completed');
