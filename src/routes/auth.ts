import { Router, Request, Response } from 'express';
import supabase, { getUserFromToken } from '../config/supabase';
import logger from '../lib/logger';
import provisioningService from '../services/provisioning.service';
import { generateUniqueSlug } from '../lib/supabase.utils';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { resolveNextRoute } from '../lib/routing';
import { deriveProfile } from '../lib/authBootstrap';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// TableNow uses ONE authentication chain: Supabase Auth.
//   - Google OAuth, email/password, password reset and email confirmation all
//     happen client-side via supabase-js and yield a Supabase access_token.
//   - Every protected route validates that Supabase token (middleware/auth.ts).
//   - POST /auth/bootstrap turns a session into a linked restaurant.
//   - GET  /auth/app-state returns the routing/permission context.
//
// The legacy bcrypt + homemade-JWT endpoints (/register, /login, /verify-email,
// /google, /google/callback) were removed: they issued tokens the Supabase-only
// middleware rejected, which left users "logged in" but unable to call any
// protected route. Do not reintroduce a parallel auth path.
// ─────────────────────────────────────────────────────────────────────────────

// ── POST /auth/bootstrap ───────────────────────────────────────────────────────
// Provider-agnostic: takes the authenticated Supabase session and ensures a
// restaurant exists for the user. Idempotent — links an existing restaurant by
// email, creates one only when none exists, and always backfills slug +
// supabase_user_id so subsequent requests resolve by supabase_user_id.
//
// The token comes from the body ({ access_token }) OR the Authorization header
// (the axios interceptor attaches it). We accept both so every entry point works.
router.post('/bootstrap', async (req: Request, res: Response) => {
    const access_token =
        req.body?.access_token ||
        (req.headers.authorization?.startsWith('Bearer ') && req.headers.authorization.slice(7));

    if (!access_token) {
        return res.status(400).json({ error: 'Access token required' });
    }

    try {
        const authUser = await getUserFromToken(access_token);
        if (!authUser) return res.status(401).json({ error: 'Invalid Supabase token' });
        logger.info({ email: authUser.email }, 'Bootstrap: Supabase user validated');

        const profile = deriveProfile(authUser as any);
        if (!profile.email) return res.status(400).json({ error: 'No email in token' });

        const { data: existing, error: lookupError } = await supabase
            .from('restaurants')
            .select('*')
            .eq('email', profile.email)
            .maybeSingle();
        if (lookupError) return res.status(500).json({ error: 'Database error', detail: lookupError.message });

        // ── Create path: no restaurant for this email yet ──────────────────────
        if (!existing) {
            let slug = generateUniqueSlug(profile.name);
            const { data: slugTaken } = await supabase
                .from('restaurants').select('id').eq('slug', slug).maybeSingle();
            if (slugTaken) slug = `${slug}-${Date.now().toString(36).slice(-6)}`;

            const { data: created, error: insertErr } = await supabase
                .from('restaurants')
                .insert({
                    email: profile.email,
                    name: profile.name,
                    owner_name: profile.name,
                    supabase_user_id: profile.id,
                    slug,
                })
                .select().single();
            if (insertErr || !created) {
                return res.status(500).json({ error: 'Insert failed', detail: insertErr?.message });
            }

            // VAPI provisioning is a replayable side effect — never blocks bootstrap.
            setImmediate(async () => {
                try {
                    await provisioningService.provision(created);
                } catch (err) {
                    logger.error({ err, restaurantId: created.id }, 'VAPI provisioning error');
                    await supabase.from('restaurants').update({ status: 'error' }).eq('id', created.id);
                }
            });

            const { password: _pw, ...safeRest } = created as any;
            logger.info({ id: created.id, slug: created.slug }, 'Bootstrap: created restaurant');
            return res.json({ restaurant: safeRest, is_new_user: true });
        }

        // ── Link path: restaurant exists — backfill slug + supabase_user_id ─────
        let restaurant = existing;
        const updates: Record<string, unknown> = {};
        if (!restaurant.slug) updates.slug = generateUniqueSlug(restaurant.name || profile.name);
        if (!restaurant.supabase_user_id) updates.supabase_user_id = profile.id;
        if (Object.keys(updates).length > 0) {
            const { data: updated } = await supabase
                .from('restaurants').update(updates).eq('id', restaurant.id).select().single();
            restaurant = updated || { ...restaurant, ...updates };
        }

        const { password: _pw, ...safeRest } = restaurant as any;
        logger.info({ id: restaurant.id, slug: restaurant.slug }, 'Bootstrap: linked restaurant');
        return res.json({ restaurant: safeRest, is_new_user: false });
    } catch (err: any) {
        logger.error({ err: err?.message, stack: err?.stack?.slice(0, 200) }, 'Bootstrap error');
        res.status(500).json({ error: 'Internal error', detail: err?.message });
    }
});

// ── GET /auth/app-state (and legacy alias /auth/me) ─────────────────────────────
// Unified auth + permission + routing context. next_route is the single source of
// routing truth (see lib/routing.ts); the frontend follows it verbatim.
async function getUserContextWithNextRoute(req: AuthRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const restaurantId = req.user?.restaurantId;

    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // Fetch restaurant data
    let restaurant = null;
    if (restaurantId) {
      const { data, error } = await supabase
        .from('restaurants')
        .select('*')
        .eq('id', restaurantId)
        .single();

      if (error && error.code !== 'PGRST116') {
        logger.error({ err: error }, 'Error fetching restaurant');
      }
      restaurant = data;
    }

    // Determine if restaurant is complete
    const is_complete =
      restaurant &&
      restaurant.name &&
      restaurant.owner_name &&
      restaurant.address &&
      restaurant.phone;

    // Hours step is satisfied once opening_hours holds at least one entry.
    const has_hours =
      !!restaurant &&
      Array.isArray(restaurant.opening_hours) &&
      restaurant.opening_hours.length > 0;

    // Calendar step is satisfied when connected OR explicitly skipped.
    const calendar_skipped = !!restaurant?.calendar_skipped_at;

    // ── Real state derivations (no fictitious value when a real column exists) ────
    // Onboarding reflects the restaurant identity profile, which is exactly what
    // gates next_route. It is never "not_started" once a restaurant row exists.
    const onboardingStatus: 'not_started' | 'in_progress' | 'complete' = !restaurant
      ? 'not_started'
      : is_complete
        ? 'complete'
        : 'in_progress';

    // Provisioning (VAPI phone) derived from the real vapi_* columns + status.
    const provisioningStatus: 'not_started' | 'in_progress' | 'complete' | 'error' =
      restaurant?.vapi_phone_number && restaurant?.vapi_assistant_id
        ? 'complete'
        : restaurant?.status === 'error'
          ? 'error'
          : restaurant?.status === 'provisioning'
            ? 'in_progress'
            : 'not_started';

    // Assistant derived from the real vapi_assistant_id column + status.
    const assistantStatus: 'inactive' | 'provisioning' | 'active' | 'error' =
      restaurant?.vapi_assistant_id
        ? 'active'
        : restaurant?.status === 'provisioning'
          ? 'provisioning'
          : restaurant?.status === 'error'
            ? 'error'
            : 'inactive';

    // Calendar, provisioning and assistant are surfaced as real state but do NOT
    // gate next_route in this lot — only restaurant identity completeness does.
    return res.json({
      version: 1,
      user: {
        id: userId,
        email: req.user?.email || '',
      },
      restaurant: restaurant
        ? {
            id: restaurant.id,
            name: restaurant.name ?? null,
            slug: restaurant.slug ?? null,
            status: restaurant.status ?? null,
            is_complete: !!is_complete,
            has_hours,
            owner_name: restaurant.owner_name ?? null,
            phone: restaurant.phone ?? null,
            address: restaurant.address ?? null,
            email: restaurant.email ?? null,
          }
        : null,
      subscription: {
        // No billing column exists yet — 'none' is the honest default, not a gate.
        status: 'none',
      },
      calendar: {
        status: restaurant?.calendar_status || 'not_connected',
        skipped: calendar_skipped,
      },
      provisioning: {
        status: provisioningStatus,
        phone_number: restaurant?.vapi_phone_number ?? null,
      },
      onboarding: {
        status: onboardingStatus,
      },
      assistant: {
        status: assistantStatus,
      },
      next_route: resolveNextRoute({
        restaurant: restaurant ? { slug: restaurant.slug, is_complete: !!is_complete } : null,
      }),
    });
  } catch (err: any) {
    logger.error({ err: err?.message, stack: err?.stack?.slice(0, 200) }, '[/app-state] Error fetching user data');
    return res.status(500).json({
      error: 'Failed to fetch user data',
      detail: err?.message,
    });
  }
}

router.get('/me', authenticateToken, getUserContextWithNextRoute);
router.get('/app-state', authenticateToken, getUserContextWithNextRoute);

export default router;
