import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import path from 'path';
import supabase from '../config/supabase';
import emailService from '../services/email.service';
import ragService from '../services/rag.service';
import logger from '../lib/logger';
import provisioningService from '../services/provisioning.service';
import { ValidationError } from '../lib/errors';
import { safeSingle, generateUniqueSlug, generateSlugWithFallback } from '../lib/supabase.utils';
import { validate } from '../middleware/handlers';
import { RegisterSchema, LoginSchema, VerifyEmailSchema, GoogleSubpabaseSchema } from '../types/schemas';

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

// ── Register ─────────────────────────────────────────────────────────────────────────────

router.post('/register', upload.fields([
    { name: 'menu',     maxCount: 1 },
    { name: 'faq',      maxCount: 1 },
    { name: 'policies', maxCount: 1 },
]), async (req: Request, res: Response, next) => {
    try {
        // Validate required fields
        const result = RegisterSchema.safeParse(req.body);
        if (!result.success) {
            return next(new ValidationError('Validation failed', result.error.errors.map(e => ({ field: e.path.join('.'), message: e.message }))));
        }

        const {
            email, password, restaurantName, ownerName,
            phone, address, cuisineType, openingHours, specialFeatures, faqText,
        } = result.data as any;

        const existingUser = await safeSingle(
            supabase.from('restaurants').select('id').eq('email', email),
            'register: check email'
        );
        if (existingUser) return res.status(409).json({ error: 'Email already registered' });

        const hashedPassword    = await bcrypt.hash(password, 10);
        const verificationToken = uuidv4();

        let slug = generateUniqueSlug(restaurantName);
        const existingSlug = await safeSingle(
            supabase.from('restaurants').select('id').eq('slug', slug),
            'register: check slug'
        );
        if (existingSlug) slug = `${slug}-${Date.now().toString(36).slice(-6)}`;

        const files = req.files as { [fieldname: string]: Express.Multer.File[] };
        const documents: Record<string, string> = {};
        if (files?.menu)     documents.menu_url     = files.menu[0].path;
        if (files?.faq)      documents.faq_url      = files.faq[0].path;
        if (files?.policies) documents.policies_url = files.policies[0].path;

        const { data: restaurant, error: dbError } = await supabase
            .from('restaurants')
            .insert({
                email, password: hashedPassword, name: restaurantName, owner_name: ownerName,
                phone, address, cuisine_type: cuisineType, opening_hours: openingHours,
                special_features: specialFeatures, faq_text: faqText,
                menu_url: documents.menu_url, faq_document_url: documents.faq_url,
                policies_url: documents.policies_url,
                verification_token: verificationToken,
                is_verified: false, status: 'pending', slug,
            })
            .select()
            .single();

        if (dbError || !restaurant) {
            logger.error({ dbError }, 'Registration DB error');
            return res.status(500).json({ error: 'Failed to create account' });
        }

        try {
            await emailService.sendVerificationEmail(email, verificationToken, restaurantName);
        } catch (emailErr) {
            logger.warn({ emailErr }, '⚠️ Verification email failed — auto-verifying');
            await supabase
                .from('restaurants')
                .update({ is_verified: true, verification_token: null, status: 'provisioning' })
                .eq('id', restaurant.id);
            setImmediate(async () => {
                try {
                    await provisioningService.provision(restaurant);
                } catch (vapiErr) {
                    logger.error({ vapiErr }, '❌ Fallback VAPI provisioning error');
                }
            });
        }

        if (files && Object.keys(files).length > 0) {
            processDocumentsInBackground(restaurant.id, files).catch(err =>
                logger.error({ err }, 'Background document processing error')
            );
        }

        res.status(201).json({ message: 'Account created successfully.', restaurantId: restaurant.id });
    } catch (error: any) {
        logger.error({ error }, 'Registration error');
        next(error);
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

// ── Verify email ─────────────────────────────────────────────────────────────────────

router.post('/verify-email', validate(VerifyEmailSchema), async (req: Request, res: Response, next) => {
    try {
        const { token } = req.body;

        const restaurant = await safeSingle(
            supabase.from('restaurants').select('*').eq('verification_token', token),
            'verify-email: find token'
        );

        if (!restaurant) return res.status(404).json({ error: 'Invalid verification token' });

        const { password: _, verification_token: __, ...restaurantData } = restaurant;

        // Already verified — still return JWT + restaurant so the user can auto-login
        if (restaurant.is_verified) {
            const jwtToken = jwt.sign(
                { id: restaurant.id, email: restaurant.email, restaurantId: restaurant.id },
                process.env.JWT_SECRET!,
                { expiresIn: '30d' }
            );
            return res.json({
                message: 'Email already verified.',
                token: jwtToken,
                restaurant: restaurantData,
                status: restaurant.status,
            });
        }

        const { error: updateError } = await supabase
            .from('restaurants')
            .update({ is_verified: true, verification_token: null, status: 'provisioning' })
            .eq('id', restaurant.id);

        if (updateError) return res.status(500).json({ error: 'Failed to verify email' });

        setImmediate(async () => {
            try {
                const { phoneNumber, bccEmail } = await provisioningService.provision(restaurant);
                await emailService.sendRestaurantNotification({
                    to:      restaurant.email,
                    subject: '🎉 Votre compte TableNow est prêt !',
                    message: `
                        <h2>Bienvenue sur TableNow !</h2>
                        <p>Votre assistant IA est configuré et prêt à prendre des appels.</p>
                        <div style="background:#f0f0f0;padding:20px;margin:20px 0;border-radius:8px;">
                          <h3>📞 Votre numéro IA :</h3>
                          <p style="font-size:24px;font-weight:bold;color:#000;">${phoneNumber}</p>
                          <h3>📧 Votre e-mail BCC (Zenchef/SevenRooms) :</h3>
                          <p style="font-size:18px;font-weight:bold;color:#000;">${bccEmail}</p>
                        </div>
                        <h3>Prochaines étapes :</h3>
                        <ol>
                          <li>Ajoutez le BCC e-mail dans vos notifications Zenchef ou SevenRooms</li>
                          <li>Testez votre numéro IA en l'appelant</li>
                          <li>Configurez vos paramètres dans le tableau de bord</li>
                        </ol>
                    `,
                });
            } catch (vapiError: any) {
                logger.error({ vapiError }, '❌ VAPI provisioning error after verification');
                await emailService.sendRestaurantNotification({
                    to:      restaurant.email,
                    subject: 'Compte vérifié — configuration en cours',
                    message: 'Votre compte a été vérifié. Nous configurons votre assistant IA et vous notifierons dès que tout est prêt.',
                });
            }
        });

        // Return JWT + restaurant immediately → frontend can auto-login without /me round-trip
        const jwtToken = jwt.sign(
            { id: restaurant.id, email: restaurant.email, restaurantId: restaurant.id },
            process.env.JWT_SECRET!,
            { expiresIn: '30d' }
        );

        res.json({
            message: 'Email vérifié ! Bienvenue dans TableNow.',
            token: jwtToken,
            restaurant: { ...restaurantData, is_verified: true, status: 'provisioning' },
            status: 'provisioning',
        });
    } catch (error: any) {
        logger.error({ error }, 'Verification error');
        res.status(500).json({ error: 'Verification failed' });
    }
});

// ── Login ──────────────────────────────────────────────────────────────────────────────────

router.post('/login', validate(LoginSchema), async (req: Request, res: Response, next) => {
    try {
        const { email, password } = req.body;

        const restaurant = await safeSingle(
            supabase.from('restaurants').select('*').eq('email', email),
            'login: find by email'
        );
        if (!restaurant) return res.status(401).json({ error: 'Invalid credentials' });
        if (!restaurant.is_verified)  return res.status(403).json({ error: 'Please verify your email first' });

        const isValidPassword = await bcrypt.compare(password, restaurant.password);
        if (!isValidPassword) return res.status(401).json({ error: 'Invalid credentials' });

        const token = jwt.sign(
            { id: restaurant.id, email: restaurant.email, restaurantId: restaurant.id },
            process.env.JWT_SECRET!,
            { expiresIn: '30d' }
        );

        const { password: _, ...restaurantData } = restaurant;
        res.json({ token, restaurant: restaurantData });
    } catch (error: any) {
        logger.error({ error }, 'Login error');
        res.status(500).json({ error: 'Login failed' });
    }
});

// ── Google OAuth via Supabase ──────────────────────────────────────────────────────

router.get('/google', (_req: Request, res: Response) => {
    const supabaseUrl = process.env.SUPABASE_URL!;
    const redirectTo  = `${process.env.FRONTEND_URL || 'https://app.tablenow.io'}/auth/callback`;
    const params      = new URLSearchParams({ provider: 'google', redirect_to: redirectTo });
    res.redirect(`${supabaseUrl}/auth/v1/authorize?${params}`);
});

router.get('/google/callback', (_req: Request, res: Response) => {
    const frontendUrl = process.env.FRONTEND_URL || 'https://app.tablenow.io';
    res.redirect(`${frontendUrl}/auth/callback`);
});

// ── Supabase Google OAuth token exchange ───────────────────────────────────────────

router.post('/google/supabase', validate(GoogleSubpabaseSchema), async (req: Request, res: Response, next) => {
    const { access_token } = req.body;
    try {
        const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
            headers: {
                'Authorization': `Bearer ${access_token}`,
                'apikey':        process.env.SUPABASE_ANON_KEY!,
                'Content-Type':  'application/json',
            },
        });
        const userBody = await userRes.json() as any;
        logger.info({ status: userRes.status, email: userBody?.email }, 'Supabase user fetch');
        if (!userRes.ok) return res.status(401).json({ error: 'Invalid Supabase token', detail: userBody });

        const email = userBody.email;
        if (!email) return res.status(400).json({ error: 'No email in token' });

        const googleName = userBody.user_metadata?.full_name || userBody.user_metadata?.name || email.split('@')[0];
        const googlePhoto = userBody.user_metadata?.avatar_url || userBody.user_metadata?.picture || null;
        const googleId = userBody.id;

        let restaurant = await safeSingle(
            supabase.from('restaurants').select('*').eq('email', email),
            'google/supabase: find by email'
        );
        logger.info({ found: !!restaurant, email }, 'DB lookup');

        if (!restaurant) {
            const name = googleName;
            let slug = generateUniqueSlug(name);

            const existingSlug = await safeSingle(
                supabase.from('restaurants').select('id').eq('slug', slug),
                'google/supabase: check slug'
            );
            if (existingSlug) {
                slug = `${slug}-${Date.now().toString(36).slice(-6)}`;
            }

            logger.info({ name, slug, email }, 'Creating restaurant from Google OAuth');
            const { data: newRest, error: insertErr } = await supabase
                .from('restaurants')
                .insert({ email, name, owner_name: name, google_id: googleId, slug })
                .select().single();
            if (insertErr) return res.status(500).json({ error: 'Insert failed', detail: insertErr.message });
            const createdRestaurant = newRest;

            // Provision VAPI asynchronously for new restaurants
            setImmediate(async () => {
                try {
                    await provisioningService.provision(createdRestaurant);
                } catch (vapiErr) {
                    logger.error({ vapiErr, restaurantId: createdRestaurant.id }, '❌ VAPI provisioning error');
                    await supabase.from('restaurants').update({ status: 'error' }).eq('id', createdRestaurant.id);
                }
            });

            const { password: _pw, ...safeRest } = createdRestaurant as any;
            const token = jwt.sign(
                { id: createdRestaurant.id, email: createdRestaurant.email, restaurantId: createdRestaurant.id },
                process.env.JWT_SECRET!,
                { expiresIn: '30d' }
            );
            logger.info({ id: createdRestaurant.id, slug: createdRestaurant.slug }, 'New user auto-provisioning');
            return res.json({
                token,
                restaurant: safeRest,
                is_new_user: true,
                google_profile: { email, name: googleName, photo: googlePhoto }
            });
        }

        if (!restaurant.slug) {
            const slug = generateUniqueSlug(restaurant.name);
            await supabase.from('restaurants').update({ slug }).eq('id', restaurant.id);
            restaurant = { ...restaurant, slug };
        }

        if (!restaurant) return res.status(500).json({ error: 'Could not find or create restaurant' });

        // Existing restaurant — return login data with google_profile for optional prefill
        logger.info({ id: restaurant.id, slug: restaurant.slug }, 'Existing user login');
        const { password: _pw, ...safeRest } = restaurant as any;
        const token = jwt.sign(
            { id: restaurant.id, email: restaurant.email, restaurantId: restaurant.id },
            process.env.JWT_SECRET!,
            { expiresIn: '30d' }
        );
        res.json({
            token,
            restaurant: safeRest,
            is_new_user: false,
            google_profile: { email, name: googleName, photo: googlePhoto }
        });
    } catch (err: any) {
        logger.error({ err: err?.message, stack: err?.stack?.slice(0, 200) }, 'Supabase token exchange error');
        res.status(500).json({ error: 'Internal error', detail: err?.message });
    }
});

// ── Get current user ───────────────────────────────────────────────────────────────────

router.get('/me', async (req: Request, res: Response, next) => {
    try {
        const token = req.headers['authorization']?.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'Access token required' });

        const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
        const restaurant = await safeSingle(
            supabase.from('restaurants').select('*').eq('id', decoded.restaurantId || decoded.id),
            'me: find by id'
        );
        if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

        const { password: _, ...restaurantData } = restaurant;
        res.json({ restaurant: restaurantData });
    } catch (error: any) {
        logger.error({ error }, 'Get user error');
        res.status(403).json({ error: 'Invalid token' });
    }
});

export default router;
