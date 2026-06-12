import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import supabase, { getUserFromToken } from '../config/supabase';
import logger from '../lib/logger';
import provisioningService from '../services/provisioning.service';
import emailService from '../services/email.service';
import { generateUniqueSlug } from '../lib/supabase.utils';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { resolveNextRoute } from '../lib/routing';
import { deriveProfile } from '../lib/authBootstrap';
import { validate } from '../middleware/handlers';
import { BootstrapSchema } from '../schemas';

const router = Router();

// ── POST /auth/register ────────────────────────────────────────────────────────
// Creates a Supabase Auth user (unconfirmed) + restaurant row + sends our custom
// verification email. The user must click the link before they can log in.
router.post('/register', async (req: Request, res: Response) => {
    try {
        const {
            email, password, restaurantName, ownerName,
            phone, address, cuisineType, website,
            lat, lng, google_place_id, google_maps_url, opening_hours_google,
        } = req.body;

        if (!email || !password || !restaurantName || !ownerName) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const { data: existingUser } = await supabase
            .from('restaurants').select('id').eq('email', email).maybeSingle();
        if (existingUser) return res.status(409).json({ error: 'Email already registered' });

        const { data: created, error: createErr } = await supabase.auth.admin.createUser({
            email,
            password,
            email_confirm: false,
            user_metadata: { full_name: ownerName },
        });
        if (createErr || !created?.user) {
            const msg = createErr?.message || '';
            if (/already|exists|registered/i.test(msg)) {
                return res.status(409).json({ error: 'Email already registered' });
            }
            logger.error({ err: msg }, 'Supabase admin.createUser failed');
            return res.status(500).json({ error: 'Failed to create account' });
        }
        const supabaseUserId = created.user.id;

        let slug = generateUniqueSlug(restaurantName);
        const { data: slugTaken } = await supabase
            .from('restaurants').select('id').eq('slug', slug).maybeSingle();
        if (slugTaken) slug = `${slug}-${Date.now().toString(36).slice(-6)}`;

        const verificationToken = uuidv4();

        const insertPayload: Record<string, unknown> = {
            supabase_user_id: supabaseUserId,
            email, name: restaurantName, owner_name: ownerName,
            phone: phone || null, address: address || null,
            cuisine_type: cuisineType || null, website: website || null,
            is_verified: false, status: 'provisioning', slug,
            verification_token: verificationToken,
        };
        if (lat != null) insertPayload.lat = lat;
        if (lng != null) insertPayload.lng = lng;
        if (google_place_id) insertPayload.google_place_id = google_place_id;
        if (google_maps_url) insertPayload.google_maps_url = google_maps_url;
        if (opening_hours_google) insertPayload.opening_hours_google = opening_hours_google;

        const { data: restaurant, error: dbError } = await supabase
            .from('restaurants')
            .insert(insertPayload)
            .select()
            .single();

        if (dbError || !restaurant) {
            logger.error({ dbError }, 'Registration DB error');
            await supabase.auth.admin.deleteUser(supabaseUserId).catch(() => {});
            return res.status(500).json({ error: 'Failed to create account' });
        }

        // Send our custom verification email (matches the mockup design)
        try {
            await emailService.sendVerificationEmail(email, verificationToken, restaurantName);
        } catch (emailErr) {
            logger.error({ emailErr }, 'Verification email failed (non-blocking)');
        }

        // VAPI provisioning in background
        setImmediate(async () => {
            try {
                await provisioningService.provision(restaurant);
            } catch (vapiErr) {
                logger.error({ vapiErr }, 'VAPI provisioning error (register)');
                await supabase.from('restaurants').update({ status: 'error' }).eq('id', restaurant.id);
            }
        });

        res.status(201).json({ message: 'Account created successfully.', restaurantId: restaurant.id });
    } catch (error: any) {
        logger.error({ error }, 'Registration error');
        res.status(500).json({ error: 'Registration failed' });
    }
});

// ── POST /auth/verify-email ────────────────────────────────────────────────────
// Clicked from the verification email link. Confirms the Supabase Auth user so
// they can sign in, marks the restaurant verified, then redirects to login.
router.post('/verify-email', async (req: Request, res: Response) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });

    try {
        const { data: restaurant, error } = await supabase
            .from('restaurants')
            .select('id, supabase_user_id')
            .eq('verification_token', token)
            .maybeSingle();

        if (error || !restaurant) {
            return res.status(404).json({ error: 'Invalid or expired token' });
        }

        // Confirm the Supabase Auth user so signInWithPassword works
        if (restaurant.supabase_user_id) {
            await supabase.auth.admin.updateUserById(restaurant.supabase_user_id, {
                email_confirm: true,
            });
        }

        // Mark restaurant as verified and clear the token
        await supabase
            .from('restaurants')
            .update({ is_verified: true, verification_token: null })
            .eq('id', restaurant.id);

        res.json({ message: 'Email verified successfully' });
    } catch (err: any) {
        logger.error({ err: err?.message }, 'Email verification error');
        res.status(500).json({ error: 'Verification failed' });
    }
});

// ── POST /auth/bootstrap ───────────────────────────────────────────────────────
// Provider-agnostic: takes the authenticated Supabase session and ensures a
// restaurant exists for the user. Idempotent — links an existing restaurant by
// email, creates one only when none exists, and always backfills slug +
// supabase_user_id so subsequent requests resolve by supabase_user_id.
//
// Body must be exactly { access_token: string } — validated by BootstrapSchema.strict().
// The token is always explicit from the body; the Authorization header is NOT a fallback
// here (bootstrap is a deliberate step, not an implicit middleware chain).
router.post('/bootstrap', validate(BootstrapSchema), async (req: Request, res: Response) => {
    const { access_token } = req.body;

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
        if (lookupError) {
            logger.error({ err: lookupError.message }, 'Bootstrap: database lookup failed');
            return res.status(500).json({ error: 'Database error' });
        }

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
                logger.error({ err: insertErr?.message }, 'Bootstrap: insert failed');
                return res.status(500).json({ error: 'Failed to create restaurant' });
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
        res.status(500).json({ error: 'Internal error' });
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
