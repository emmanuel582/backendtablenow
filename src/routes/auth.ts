import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import path from 'path';
import supabase from '../config/supabase';
import emailService from '../services/email.service';
import vapiService from '../services/vapi.service';
import ragService from '../services/rag.service';
import logger from '../lib/logger';

const router = Router();

function generateSlug(name: string): string {
    return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ── Multer ────────────────────────────────────────────────────────────────────

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, 'uploads/'),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`),
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

// ── Shared provisioning ───────────────────────────────────────────────────────
// Single source of truth used by verify-email, fallback bypass, and retry-vapi.

export async function provisionVapi(restaurant: {
    id: string;
    name: string;
    email: string;
    phone?: string;
}): Promise<{
    assistantId: string;
    phoneNumber: string;
    phoneId: string;
    bccEmail: string;
}> {
    const log = logger.child({ restaurantId: restaurant.id, fn: 'provisionVapi' });
    log.info('🚀 Starting VAPI provisioning');

    const assistant = await vapiService.createAssistant(restaurant);
    log.info({ assistantId: assistant.id }, '✅ Assistant created');

    await supabase.from('restaurants').update({ vapi_assistant_id: assistant.id }).eq('id', restaurant.id);

    const phoneNumber = await vapiService.createPhoneNumber(restaurant.id, restaurant.name);
    log.info({ phone: phoneNumber.number, phoneId: phoneNumber.id }, '✅ Phone assigned');

    await supabase.from('restaurants').update({
        vapi_phone_id: phoneNumber.id,
        vapi_phone_number: phoneNumber.number || phoneNumber.id,
    }).eq('id', restaurant.id);

    await vapiService.linkAssistantToPhone(phoneNumber.id, assistant.id);
    log.info('✅ Assistant linked to phone');

    const emailDomain = process.env.EMAIL_DOMAIN;
    if (!emailDomain) throw new Error('EMAIL_DOMAIN env variable is not set');
    const bccEmail = `bcc+r-${restaurant.id}@${emailDomain}`;

    await supabase.from('restaurants').update({ bcc_email: bccEmail, status: 'active' }).eq('id', restaurant.id);
    log.info({ bccEmail }, '✅ VAPI provisioning complete');

    return { assistantId: assistant.id, phoneNumber: phoneNumber.number || phoneNumber.id, phoneId: phoneNumber.id, bccEmail };
}

// ── Register ──────────────────────────────────────────────────────────────────

router.post('/register', upload.fields([
    { name: 'menu', maxCount: 1 },
    { name: 'faq', maxCount: 1 },
    { name: 'policies', maxCount: 1 },
]), async (req: Request, res: Response) => {
    try {
        const { email, password, restaurantName, ownerName, phone, address, cuisineType, openingHours, specialFeatures, faqText } = req.body;

        if (!email || !password || !restaurantName || !ownerName) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const { data: existingUser } = await supabase.from('restaurants').select('id').eq('email', email).single();
        if (existingUser) return res.status(409).json({ error: 'Email already registered' });

        const hashedPassword = await bcrypt.hash(password, 10);
        const verificationToken = uuidv4();

        let slug = generateSlug(restaurantName);
        const { data: existingSlug } = await supabase.from('restaurants').select('id').eq('slug', slug).single();
        if (existingSlug) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;

        const files = req.files as { [fieldname: string]: Express.Multer.File[] };
        const documents: Record<string, string> = {};
        if (files?.menu)     documents.menu_url = files.menu[0].path;
        if (files?.faq)      documents.faq_url = files.faq[0].path;
        if (files?.policies) documents.policies_url = files.policies[0].path;

        const { data: restaurant, error: dbError } = await supabase
            .from('restaurants')
            .insert({
                email, password: hashedPassword, name: restaurantName, owner_name: ownerName,
                phone, address, cuisine_type: cuisineType, opening_hours: openingHours,
                special_features: specialFeatures, faq_text: faqText,
                menu_url: documents.menu_url, faq_document_url: documents.faq_url, policies_url: documents.policies_url,
                verification_token: verificationToken, is_verified: false, status: 'pending', slug,
            })
            .select()
            .single();

        if (dbError || !restaurant) {
            logger.error({ dbError }, 'Registration DB error');
            return res.status(500).json({ error: 'Failed to create account' });
        }

        // Send verification email — if it fails, auto-verify and provision
        try {
            await emailService.sendVerificationEmail(email, verificationToken, restaurantName);
        } catch (emailErr) {
            logger.warn({ emailErr }, '⚠️ Verification email failed — auto-verifying');
            await supabase.from('restaurants').update({ is_verified: true, verification_token: null, status: 'provisioning' }).eq('id', restaurant.id);
            setImmediate(async () => {
                try {
                    await provisionVapi(restaurant);
                } catch (vapiErr) {
                    logger.error({ vapiErr }, '❌ Fallback VAPI provisioning error');
                    await supabase.from('restaurants').update({ status: 'error' }).eq('id', restaurant.id);
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
        res.status(500).json({ error: 'Registration failed' });
    }
});

// ── Background RAG processing ─────────────────────────────────────────────────

async function processDocumentsInBackground(restaurantId: string, files: { [fieldname: string]: Express.Multer.File[] }) {
    logger.info({ restaurantId }, '📚 Starting background document processing');
    for (const type of ['menu', 'faq', 'policies'] as const) {
        if (files[type]?.[0]) {
            await ragService.processAndStoreDocument(restaurantId, type, files[type][0].path, files[type][0].mimetype);
        }
    }
    logger.info({ restaurantId }, '✅ Background document processing complete');
}

// ── Verify email ──────────────────────────────────────────────────────────────

router.post('/verify-email', async (req: Request, res: Response) => {
    try {
        const { token } = req.body;
        if (!token) return res.status(400).json({ error: 'Verification token required' });

        const { data: restaurant, error: findError } = await supabase
            .from('restaurants').select('*').eq('verification_token', token).single();

        if (findError || !restaurant) return res.status(404).json({ error: 'Invalid verification token' });
        if (restaurant.is_verified) return res.status(400).json({ error: 'Email already verified' });

        const { error: updateError } = await supabase
            .from('restaurants')
            .update({ is_verified: true, verification_token: null, status: 'provisioning' })
            .eq('id', restaurant.id);

        if (updateError) return res.status(500).json({ error: 'Failed to verify email' });

        // Provision VAPI — non-blocking after response
        setImmediate(async () => {
            try {
                const { phoneNumber, bccEmail } = await provisionVapi(restaurant);
                await emailService.sendRestaurantNotification({
                    to: restaurant.email,
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
                await supabase.from('restaurants').update({ status: 'error' }).eq('id', restaurant.id);
                await emailService.sendRestaurantNotification({
                    to: restaurant.email,
                    subject: 'Compte vérifié — configuration en cours',
                    message: 'Votre compte a été vérifié. Nous configurons votre assistant IA et vous notifierons dès que tout est prêt.',
                });
            }
        });

        res.json({ message: 'Email vérifié. Votre assistant IA est en cours de configuration.', status: 'provisioning' });
    } catch (error: any) {
        logger.error({ error }, 'Verification error');
        res.status(500).json({ error: 'Verification failed' });
    }
});

// ── Login ─────────────────────────────────────────────────────────────────────

router.post('/login', async (req: Request, res: Response) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

        const { data: restaurant, error: findError } = await supabase.from('restaurants').select('*').eq('email', email).single();
        if (findError || !restaurant) return res.status(401).json({ error: 'Invalid credentials' });
        if (!restaurant.is_verified) return res.status(403).json({ error: 'Please verify your email first' });

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

// ── Google OAuth via Supabase ─────────────────────────────────────────────────

router.get('/google', (req: Request, res: Response) => {
    const supabaseUrl = process.env.SUPABASE_URL!;
    const redirectTo = `${process.env.FRONTEND_URL || 'https://app.tablenow.io'}/auth/callback`;
    const params = new URLSearchParams({
        provider: 'google',
        redirect_to: redirectTo,
    });
    res.redirect(`${supabaseUrl}/auth/v1/authorize?${params}`);
});

router.get('/google/callback', async (req: Request, res: Response) => {
    // Supabase gère le callback directement — cette route sert de fallback
    const frontendUrl = process.env.FRONTEND_URL || 'https://app.tablenow.io';
    res.redirect(`${frontendUrl}/auth/callback`);
});

// ── Supabase Google OAuth token exchange ──────────────────────────────────────
router.post('/google/supabase', async (req: Request, res: Response) => {
    const { access_token } = req.body;
    if (!access_token) return res.status(400).json({ error: 'Missing access_token' });
    try {
        // Vérifier le token Supabase — fonctionne avec JWT et tokens opaques
        const userRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
            headers: {
                'Authorization': `Bearer ${access_token}`,
                'apikey': process.env.SUPABASE_ANON_KEY!,
                'Content-Type': 'application/json',
            },
        });
        const userBody = await userRes.json() as any;
        logger.info({ status: userRes.status, email: userBody?.email, error: userBody?.error }, 'Supabase user fetch');
        if (!userRes.ok) return res.status(401).json({ error: 'Invalid Supabase token', detail: userBody });
        const supabaseUser = userBody;
        const email = supabaseUser.email;
        if (!email) return res.status(400).json({ error: 'No email in token' });

        // Trouver ou créer le restaurant
        // Chercher le restaurant — utiliser mayfail car plusieurs résultats possibles
        logger.info({ email }, 'Looking up restaurant by email');
        const { data: restaurants } = await supabase.from('restaurants').select('*').eq('email', email).limit(1);
        let restaurant: any = restaurants?.[0] || null;
        logger.info({ found: !!restaurant }, 'DB lookup');

        if (!restaurant) {
            const name = supabaseUser.user_metadata?.full_name || supabaseUser.user_metadata?.name || email.split('@')[0];
            const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || `resto-${Date.now().toString(36)}`;
            logger.info({ name, slug }, 'Creating restaurant');
            const { data: newRest, error: insertErr } = await supabase.from('restaurants').insert({
                email, name, owner_name: name,
                google_id: supabaseUser.id, slug,
            }).select().single();
            logger.info({ created: !!newRest, insertErr: insertErr?.message }, 'Insert result');
            if (insertErr) return res.status(500).json({ error: 'Insert failed', detail: insertErr.message });
            restaurant = newRest;
        } else if (!restaurant.slug) {
            const slug = restaurant.name?.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || `resto-${restaurant.id.slice(0,8)}`;
            await supabase.from('restaurants').update({ slug }).eq('id', restaurant.id);
            restaurant = { ...restaurant, slug };
        }
        if (!restaurant) return res.status(500).json({ error: 'Could not find or create restaurant' });

        logger.info({ id: restaurant.id, slug: restaurant.slug }, 'Signing token');
        const { password: _pw, ...safeRest } = restaurant as any;
        const token = jwt.sign(
            { restaurantId: restaurant.id, email: restaurant.email },
            process.env.JWT_SECRET!,
            { expiresIn: '30d' }
        );
        res.json({ token, restaurant: safeRest });
    } catch (err: any) {
        logger.error({ err: err?.message || err, stack: err?.stack?.slice(0,200) }, 'Supabase token exchange error');
        res.status(500).json({ error: 'Internal error', detail: err?.message });
    }
});

// ── Get current user ──────────────────────────────────────────────────────────

router.get('/me', async (req: Request, res: Response) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader?.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'Access token required' });

        const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;

        const { data: restaurant, error } = await supabase.from('restaurants').select('*').eq('id', decoded.restaurantId).single();
        if (error || !restaurant) return res.status(404).json({ error: 'Restaurant not found' });

        const { password: _, ...restaurantData } = restaurant;
        res.json({ restaurant: restaurantData });
    } catch (error: any) {
        logger.error({ error }, 'Get user error');
        res.status(403).json({ error: 'Invalid token' });
    }
});

export default router;
