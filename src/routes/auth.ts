import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import path from 'path';
import supabase, { getUserFromToken } from '../config/supabase';
import emailService from '../services/email.service';
import ragService from '../services/rag.service';
import logger from '../lib/logger';
import provisioningService from '../services/provisioning.service';
import { generateUniqueSlug } from '../lib/supabase.utils';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { resolveNextRoute, type UserContext } from '../lib/routing';
import { validate } from '../middleware/handlers';
import { AuthGoogleSchema } from '../schemas/authGoogleSchema';

const router = Router();

// ── Multer ────────────────────────────────────────────────────────────────────────────────

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, 'uploads/'),
    filename:    (_req, file, cb) => cb(null, `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`),
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const allowed = /pdf|doc|docx|txt|jpg|jpeg|png/;
        if (allowed.test(path.extname(file.originalname).toLowerCase()) && allowed.test(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only documents and images are allowed'));
        }
    },
});

// ── Helper : créer une unique slug ───────────────────────────────────────────────────────
async function ensureUniqueSlug(base: string): Promise<string> {
    let slug = generateUniqueSlug(base);
    const { data: existing } = await supabase.from('restaurants').select('id').eq('slug', slug).maybeSingle();
    if (existing) slug = `${slug}-${Date.now().toString(36).slice(-6)}`;
    return slug;
}

// ── Register (Supabase Auth + ligne restaurants) ───────────────────────────────────────────
// Crée l'utilisateur dans Supabase Auth (email confirmé d'emblée en dev) puis la fiche
// restaurant liée par supabase_user_id. Le front se connecte ensuite via signInWithPassword.

router.post('/register', upload.fields([
    { name: 'menu',     maxCount: 1 },
    { name: 'faq',      maxCount: 1 },
    { name: 'policies', maxCount: 1 },
]), async (req: Request, res: Response) => {
    try {
        const {
            email, password, restaurantName, ownerName,
            phone, address, cuisineType, openingHours, specialFeatures, faqText,
        } = req.body;

        if (!email || !password || !restaurantName || !ownerName) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const { data: existingUser } = await supabase
            .from('restaurants').select('id').eq('email', email).maybeSingle();
        if (existingUser) return res.status(409).json({ error: 'Email already registered' });

        // 1) Créer l'utilisateur Supabase Auth (confirmé directement — dev)
        const { data: created, error: createErr } = await supabase.auth.admin.createUser({
            email,
            password,
            email_confirm: true,
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

        // 2) Créer la fiche restaurant liée
        const slug = await ensureUniqueSlug(restaurantName);

        const files = req.files as { [fieldname: string]: Express.Multer.File[] };
        const documents: Record<string, string> = {};
        if (files?.menu)     documents.menu_url     = files.menu[0].path;
        if (files?.faq)      documents.faq_url      = files.faq[0].path;
        if (files?.policies) documents.policies_url = files.policies[0].path;

        const { data: restaurant, error: dbError } = await supabase
            .from('restaurants')
            .insert({
                supabase_user_id: supabaseUserId,
                email, name: restaurantName, owner_name: ownerName,
                phone, address, cuisine_type: cuisineType, opening_hours: openingHours,
                special_features: specialFeatures, faq_text: faqText,
                menu_url: documents.menu_url, faq_document_url: documents.faq_url,
                policies_url: documents.policies_url,
                is_verified: true, status: 'provisioning', slug,
            })
            .select()
            .single();

        if (dbError || !restaurant) {
            logger.error({ dbError }, 'Registration DB error');
            // rollback du user Auth pour éviter les orphelins
            await supabase.auth.admin.deleteUser(supabaseUserId).catch(() => {});
            return res.status(500).json({ error: 'Failed to create account' });
        }

        // 3) Provisioning VAPI en arrière-plan
        setImmediate(async () => {
            try {
                await provisioningService.provision(restaurant);
            } catch (vapiErr) {
                logger.error({ vapiErr }, '❌ VAPI provisioning error (register)');
                await supabase.from('restaurants').update({ status: 'error' }).eq('id', restaurant.id);
            }
        });

        if (files && Object.keys(files).length > 0) {
            processDocumentsInBackground(restaurant.id, files).catch(err =>
                logger.error({ err }, 'Background document processing error')
            );
        }

        res.status(201).json({ message: 'Account created successfully.', restaurantId: restaurant.id });
    } catch (error: any) {
        logger.error({ error }, 'Registration error');
        res.status(500).json({ error: 'Registration failed' });
    }
});

// ── Background RAG processing ───────────────────────────────────────────────────

async function processDocumentsInBackground(
    restaurantId: string,
    files: { [fieldname: string]: Express.Multer.File[] }
) {
    logger.info({ restaurantId }, '📚 Starting background document processing');
    for (const type of ['menu', 'faq', 'policies'] as const) {
        if (files[type]?.[0]) {
            await ragService.processAndStoreDocument(
                restaurantId, type, files[type][0].path, files[type][0].mimetype
            );
        }
    }
    logger.info({ restaurantId }, '✅ Background document processing complete');
}

// ── Google OAuth (Supabase) : garantit la fiche restaurant ───────────────────────────────
// Le front établit la session Supabase (PKCE) puis appelle cette route avec l'access_token
// pour créer la fiche restaurant au premier login. Aucun JWT maison : le front utilise
// directement le token Supabase pour les appels API suivants.

router.post('/google/supabase', validate(AuthGoogleSchema), async (req: Request, res: Response) => {
    const { access_token } = req.body;
    try {
        const authUser = await getUserFromToken(access_token);
        if (!authUser || !authUser.email) {
            return res.status(401).json({ error: 'Invalid Supabase token' });
        }

        const email = authUser.email;
        const meta: any = authUser.user_metadata || {};
        const googleName = meta.full_name || meta.name || email.split('@')[0];
        const googlePhoto = meta.avatar_url || meta.picture || null;

        // Déjà lié ?
        let { data: restaurant } = await supabase
            .from('restaurants').select('*').eq('supabase_user_id', authUser.id).maybeSingle();

        // Sinon, fiche existante par email -> rattacher
        if (!restaurant) {
            const { data: byEmail } = await supabase
                .from('restaurants').select('*').eq('email', email).maybeSingle();
            if (byEmail) {
                const { data: linked } = await supabase
                    .from('restaurants')
                    .update({ supabase_user_id: authUser.id, slug: byEmail.slug || await ensureUniqueSlug(byEmail.name || email) })
                    .eq('id', byEmail.id).select().single();
                restaurant = linked || byEmail;
            }
        }

        let isNewUser = false;
        if (!restaurant) {
            // Création de la fiche au premier login Google
            const slug = await ensureUniqueSlug(googleName);
            const { data: newRest, error: insertErr } = await supabase
                .from('restaurants')
                .insert({
                    supabase_user_id: authUser.id,
                    email, name: googleName, owner_name: googleName,
                    is_verified: true, status: 'provisioning', slug,
                })
                .select().single();
            if (insertErr || !newRest) {
                logger.error({ err: insertErr?.message }, 'Google restaurant insert failed');
                return res.status(500).json({ error: 'Insert failed', detail: insertErr?.message });
            }
            restaurant = newRest;
            isNewUser = true;

            setImmediate(async () => {
                try {
                    await provisioningService.provision(newRest);
                } catch (vapiErr) {
                    logger.error({ vapiErr, restaurantId: newRest.id }, '❌ VAPI provisioning error (google)');
                    await supabase.from('restaurants').update({ status: 'error' }).eq('id', newRest.id);
                }
            });
        }

        const { password: _pw, verification_token: _vt, google_calendar_tokens: _gct, ...safeRest } = restaurant as any;
        res.json({
            restaurant: safeRest,
            is_new_user: isNewUser,
            google_profile: { email, name: googleName, photo: googlePhoto },
        });
    } catch (err: any) {
        logger.error({ err: err?.message }, 'Google supabase exchange error');
        res.status(500).json({ error: 'Internal error', detail: err?.message });
    }
});

// ── Get current user / app-state ───────────────────────────────────────────────────────

async function getUserContextWithNextRoute(req: AuthRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const restaurant = req.restaurant; // injecté par authenticateToken

    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // ── Mapping des statuts sur les VRAIES colonnes de `restaurants` ──────────────
    const provisioningStatus = restaurant?.vapi_phone_number
      ? 'complete'
      : restaurant?.status === 'provisioning'
        ? 'provisioning'
        : restaurant?.status === 'error'
          ? 'error'
          : 'not_started';
    const assistantStatus = restaurant?.vapi_assistant_id ? 'active' : 'inactive';
    const calendarStatus = restaurant?.calendar_status
      || (restaurant?.calendar_skipped_at ? 'skipped' : 'not_connected');
    const subscriptionStatus = restaurant?.is_active || restaurant?.stripe_subscription_id
      ? 'active'
      : (restaurant?.plan || 'none');
    const onboardingStatus = restaurant?.setup_complete ? 'complete' : 'not_started';

    const is_complete = !!(
      restaurant &&
      restaurant.name &&
      restaurant.owner_name &&
      restaurant.address &&
      restaurant.phone
    );

    const ctx: UserContext = {
      user: { id: userId, email: req.user?.email || '' },
      restaurant: restaurant
        ? {
            id: restaurant.id,
            status: restaurant.status || 'draft',
            is_complete: !!is_complete,
            slug: restaurant.slug,
          }
        : undefined,
      subscription: restaurant ? { status: subscriptionStatus } : undefined,
      calendar: restaurant ? { status: calendarStatus } : undefined,
      provisioning: restaurant ? { status: provisioningStatus } : undefined,
      assistant: restaurant ? { status: assistantStatus } : undefined,
      onboarding: restaurant ? { status: onboardingStatus } : undefined,
      test_call_completed: restaurant?.test_call_completed || false,
    };

    const next_route = resolveNextRoute(ctx);

    return res.json({
      user: ctx.user,
      restaurant: restaurant
        ? {
            id: restaurant.id,
            name: restaurant.name,
            slug: restaurant.slug,
            status: restaurant.status,
            is_complete,
            phone: restaurant.phone,
            email: restaurant.email,
          }
        : null,
      subscription: { status: subscriptionStatus },
      calendar: { status: calendarStatus },
      provisioning: { status: provisioningStatus, phone_number: restaurant?.vapi_phone_number },
      onboarding: { status: onboardingStatus, test_call_completed: ctx.test_call_completed },
      assistant: { status: assistantStatus },
      next_route,
    });
  } catch (err: any) {
    logger.error({ err: err?.message }, '[/me] Error fetching user data');
    return res.status(500).json({ error: 'Failed to fetch user data', detail: err?.message });
  }
}

router.get('/me', authenticateToken, getUserContextWithNextRoute);
router.get('/app-state', authenticateToken, getUserContextWithNextRoute);

export default router;
