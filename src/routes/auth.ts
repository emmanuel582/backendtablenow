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

// ── Google OAuth ──────────────────────────────────────────────────────────────

router.get('/google', (req: Request, res: Response) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const redirectUri = process.env.GOOGLE_AUTH_REDIRECT_URI || `${process.env.BACKEND_URL || 'https://api.tablenow.io'}/api/auth/google/callback`;
    if (!clientId) return res.status(500).json({ error: 'Google OAuth not configured' });
    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        access_type: 'offline',
        prompt: 'select_account',
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

router.get('/google/callback', async (req: Request, res: Response) => {
    const frontendUrl = process.env.FRONTEND_URL || 'https://app.tablenow.io';
    const { code, error } = req.query as Record<string, string>;
    if (error || !code) return res.redirect(`${frontendUrl}/login?error=google_cancelled`);
    try {
        const clientId     = process.env.GOOGLE_CLIENT_ID!;
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
        const redirectUri  = process.env.GOOGLE_AUTH_REDIRECT_URI || `${process.env.BACKEND_URL || 'https://api.tablenow.io'}/api/auth/google/callback`;
        // Exchange code for tokens
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
        });
        const tokens = await tokenRes.json() as any;
        if (!tokens.access_token) return res.redirect(`${frontendUrl}/login?error=google_token`);
        // Get user info
        const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        const googleUser = await userRes.json() as any;
        if (!googleUser.email) return res.redirect(`${frontendUrl}/login?error=google_userinfo`);
        // Find or create restaurant
        let { data: restaurant } = await supabase.from('restaurants').select('*').eq('email', googleUser.email).single();
        if (!restaurant) {
            const { data: newRest } = await supabase.from('restaurants').insert({
                email: googleUser.email,
                name: googleUser.name || googleUser.email.split('@')[0],
                owner_name: googleUser.name || '',
                email_verified: true,
                google_id: googleUser.id,
            }).select().single();
            restaurant = newRest;
        }
        if (!restaurant) return res.redirect(`${frontendUrl}/login?error=db_error`);
        const token = jwt.sign({ restaurantId: restaurant.id, email: restaurant.email }, process.env.JWT_SECRET!, { expiresIn: '30d' });
        res.redirect(`${frontendUrl}/auth/callback?token=${token}`);
    } catch (err: any) {
        logger.error({ err }, 'Google OAuth callback error');
        res.redirect(`${frontendUrl}/login?error=google_error`);
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
