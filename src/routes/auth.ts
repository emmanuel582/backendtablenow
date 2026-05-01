import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import path from 'path';
import supabase from '../config/supabase';
import emailService from '../services/email.service';
import vapiService from '../services/vapi.service';
import ragService from '../services/rag.service';
import { config } from '../lib/config';

const router = Router();

function generateSlug(name: string): string {
    return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: (req, file, cb) => {
        const allowedTypes = /pdf|doc|docx|txt|jpg|jpeg|png/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);

        if (extname && mimetype) {
            cb(null, true);
        } else {
            cb(new Error('Only documents and images are allowed'));
        }
    }
});

/**
 * Register new restaurant with document upload
 */
router.post('/register', upload.fields([
    { name: 'menu', maxCount: 1 },
    { name: 'faq', maxCount: 1 },
    { name: 'policies', maxCount: 1 }
]), async (req: Request, res: Response) => {
    try {
        const {
            email,
            password,
            restaurantName,
            ownerName,
            phone,
            address,
            cuisineType,
            openingHours,
            specialFeatures,
            faqText,
            language
        } = req.body;
        const restaurantLanguage: 'fr' | 'en' = language === 'en' ? 'en' : 'fr';

        if (!email || !password || !restaurantName || !ownerName) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const { data: existingUser } = await supabase
            .from('restaurants')
            .select('id')
            .eq('email', email)
            .single();

        if (existingUser) {
            return res.status(409).json({ error: 'Email already registered' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const verificationToken = uuidv4();

        let slug = generateSlug(restaurantName);
        const { data: existing } = await supabase
            .from('restaurants')
            .select('id')
            .eq('slug', slug)
            .single();
        if (existing) {
            slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
        }

        const files = req.files as { [fieldname: string]: Express.Multer.File[] };
        const documents: any = {};

        if (files) {
            if (files.menu) documents.menu_url = files.menu[0].path;
            if (files.faq) documents.faq_url = files.faq[0].path;
            if (files.policies) documents.policies_url = files.policies[0].path;
        }

        const { data: restaurant, error: dbError } = await supabase
            .from('restaurants')
            .insert({
                email,
                password: hashedPassword,
                name: restaurantName,
                owner_name: ownerName,
                phone,
                address,
                cuisine_type: cuisineType,
                opening_hours: openingHours,
                special_features: specialFeatures,
                faq_text: faqText,
                menu_url: documents.menu_url,
                faq_document_url: documents.faq_url,
                policies_url: documents.policies_url,
                verification_token: verificationToken,
                is_verified: false,
                status: 'pending',
                slug,
                language: restaurantLanguage,
            })
            .select()
            .single();

        if (dbError) {
            console.error('Database error:', dbError);
            return res.status(500).json({ error: 'Failed to create account' });
        }

        try {
            await emailService.sendVerificationEmail(email, verificationToken, restaurantName, restaurantLanguage);
        } catch (emailErr) {
            console.log('⚠️ Email blocked. Auto-verifying account...');
            await supabase.from('restaurants').update({ is_verified: true, verification_token: null, status: 'provisioning' }).eq('id', restaurant.id);
            (async () => {
                try {
                    const assistant = await vapiService.createAssistant(restaurant);
                    await supabase.from('restaurants').update({ vapi_assistant_id: assistant.id }).eq('id', restaurant.id);
                    const bccEmail = `bcc+r-${restaurant.id}@${config.email.domain}`;
                    await supabase.from('restaurants').update({ bcc_email: bccEmail }).eq('id', restaurant.id);
                    const phoneNumber = await vapiService.createPhoneNumber(restaurant.id, restaurant.name, assistant.id);
                    await supabase.from('restaurants').update({ vapi_phone_id: phoneNumber.id, vapi_phone_number: phoneNumber.number || phoneNumber.id }).eq('id', restaurant.id);
                    await vapiService.linkAssistantToPhone(phoneNumber.id, assistant.id);
                    await supabase.from('restaurants').update({ status: 'active' }).eq('id', restaurant.id);
                } catch (vapiErr) {
                    console.error('❌ Fallback VAPI provisioning error:', vapiErr);
                    await supabase.from('restaurants').update({ status: 'error' }).eq('id', restaurant.id);
                }
            })();
        }

        if (files && Object.keys(files).length > 0) {
            processDocumentsInBackground(restaurant.id, files).catch(err => {
                console.error('Background document processing error:', err);
            });
        }

        res.status(201).json({
            message: 'Account created successfully. You can log in immediately.',
            restaurantId: restaurant.id
        });
    } catch (error: any) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Registration failed' });
    }
});

async function processDocumentsInBackground(restaurantId: string, files: { [fieldname: string]: Express.Multer.File[] }) {
    try {
        if (files.menu && files.menu[0]) {
            await ragService.processAndStoreDocument(restaurantId, 'menu', files.menu[0].path, files.menu[0].mimetype);
        }
        if (files.faq && files.faq[0]) {
            await ragService.processAndStoreDocument(restaurantId, 'faq', files.faq[0].path, files.faq[0].mimetype);
        }
        if (files.policies && files.policies[0]) {
            await ragService.processAndStoreDocument(restaurantId, 'policies', files.policies[0].path, files.policies[0].mimetype);
        }
    } catch (error) {
        console.error('Error in background document processing:', error);
    }
}

/**
 * Verify email and provision VAPI
 */
router.post('/verify-email', async (req: Request, res: Response) => {
    try {
        const { token } = req.body;

        if (!token) {
            return res.status(400).json({ error: 'Verification token required' });
        }

        const { data: restaurant, error: findError } = await supabase
            .from('restaurants')
            .select('*')
            .eq('verification_token', token)
            .single();

        if (findError || !restaurant) {
            return res.status(404).json({ error: 'Invalid verification token' });
        }

        if (restaurant.is_verified) {
            return res.status(400).json({ error: 'Email already verified' });
        }

        const { error: updateError } = await supabase
            .from('restaurants')
            .update({ is_verified: true, verification_token: null, status: 'provisioning' })
            .eq('id', restaurant.id);

        if (updateError) {
            return res.status(500).json({ error: 'Failed to verify email' });
        }

        try {
            const assistant = await vapiService.createAssistant(restaurant);
            await supabase.from('restaurants').update({ vapi_assistant_id: assistant.id }).eq('id', restaurant.id);

            const bccEmail = `bcc+r-${restaurant.id}@${config.email.domain}`;
            await supabase.from('restaurants').update({ bcc_email: bccEmail }).eq('id', restaurant.id);

            const phoneNumber = await vapiService.createPhoneNumber(restaurant.id, restaurant.name, assistant.id);
            await supabase.from('restaurants').update({
                vapi_phone_id: phoneNumber.id,
                vapi_phone_number: phoneNumber.number || phoneNumber.id
            }).eq('id', restaurant.id);

            await vapiService.linkAssistantToPhone(phoneNumber.id, assistant.id);
            await supabase.from('restaurants').update({ status: 'active' }).eq('id', restaurant.id);

            const restaurantLang: 'fr' | 'en' = restaurant.language === 'en' ? 'en' : 'fr';
            const successPayload = restaurantLang === 'en' ? {
                subject: '🎉 Your TableNow Account is Ready!',
                message: `<h2>Welcome to TableNow!</h2><p>Your AI phone assistant is ready.</p><p><strong>📞 Your AI Phone Number:</strong> ${phoneNumber.number}</p><p><strong>📧 BCC Email:</strong> ${bccEmail}</p>`
            } : {
                subject: '🎉 Votre compte TableNow est prêt !',
                message: `<h2>Bienvenue sur TableNow&nbsp;!</h2><p>Votre assistant IA est prêt.</p><p><strong>📞 Votre numéro IA&nbsp;:</strong> ${phoneNumber.number}</p><p><strong>📧 Email BCC&nbsp;:</strong> ${bccEmail}</p>`
            };

            await emailService.sendRestaurantNotification({
                to: restaurant.email,
                subject: successPayload.subject,
                message: successPayload.message,
                language: restaurantLang
            });
        } catch (vapiError: any) {
            console.error('❌ VAPI provisioning error:', vapiError);
            await supabase.from('restaurants').update({ status: 'error' }).eq('id', restaurant.id);
        }

        res.json({ message: 'Email verified successfully!', status: 'provisioning' });
    } catch (error: any) {
        console.error('Verification error:', error);
        res.status(500).json({ error: 'Verification failed' });
    }
});

/**
 * Login
 */
router.post('/login', async (req: Request, res: Response) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }

        const { data: restaurant, error: findError } = await supabase
            .from('restaurants')
            .select('*')
            .eq('email', email)
            .single();

        if (findError || !restaurant) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        if (!restaurant.is_verified) {
            return res.status(403).json({ error: 'Please verify your email first' });
        }

        const isValidPassword = await bcrypt.compare(password, restaurant.password);
        if (!isValidPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign(
            { id: restaurant.id, email: restaurant.email, restaurantId: restaurant.id },
            process.env.JWT_SECRET!,
            { expiresIn: '30d' }
        );

        const { password: _, ...restaurantData } = restaurant;
        res.json({ token, restaurant: restaurantData });
    } catch (error: any) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

/**
 * Get current user
 */
router.get('/me', async (req: Request, res: Response) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({ error: 'Access token required' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;

        const { data: restaurant, error } = await supabase
            .from('restaurants')
            .select('*')
            .eq('id', decoded.restaurantId)
            .single();

        if (error || !restaurant) {
            return res.status(404).json({ error: 'Restaurant not found' });
        }

        const { password: _, ...restaurantData } = restaurant;
        res.json({ restaurant: restaurantData });
    } catch (error: any) {
        console.error('Get user error:', error);
        res.status(403).json({ error: 'Invalid token' });
    }
});

/**
 * Forgot password
 * SQL required: ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS reset_token VARCHAR(255);
 *               ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ;
 */
router.post('/forgot-password', async (req: Request, res: Response) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ error: 'Email required' });
        }

        const { data: restaurant } = await supabase
            .from('restaurants')
            .select('id, email, name, language')
            .eq('email', email)
            .single();

        // Always return 200 — never reveal whether email exists
        if (!restaurant) {
            return res.json({ message: 'If this email exists, a reset link has been sent.' });
        }

        const resetToken = crypto.randomBytes(32).toString('hex');
        const resetExpires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1h

        await supabase
            .from('restaurants')
            .update({ reset_token: resetToken, reset_token_expires: resetExpires })
            .eq('id', restaurant.id);

        const resetLink = `https://app.tablenow.io/reset-password?token=${resetToken}`;
        const isEn = restaurant.language === 'en';

        await emailService.sendRawEmail({
            to: restaurant.email,
            subject: isEn
                ? 'Reset your TableNow password'
                : 'Réinitialisation de votre mot de passe TableNow',
            html: isEn
                ? `<p>Hello,</p><p>Click below to reset your password. This link expires in 1 hour.</p><p><a href="${resetLink}" style="background:#b8f000;color:#000;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;">Reset my password</a></p><p>If you didn't request this, ignore this email.</p>`
                : `<p>Bonjour,</p><p>Cliquez ci-dessous pour réinitialiser votre mot de passe. Ce lien expire dans 1 heure.</p><p><a href="${resetLink}" style="background:#b8f000;color:#000;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;">Réinitialiser mon mot de passe</a></p><p>Si vous n'avez pas fait cette demande, ignorez cet email.</p>`,
            text: isEn ? `Reset your password: ${resetLink}` : `Réinitialisez votre mot de passe : ${resetLink}`,
        });

        res.json({ message: 'If this email exists, a reset link has been sent.' });
    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({ error: 'Failed to process request' });
    }
});

/**
 * Reset password — validate token + set new password
 */
router.post('/reset-password', async (req: Request, res: Response) => {
    try {
        const { token, password } = req.body;

        if (!token || !password) {
            return res.status(400).json({ error: 'Token and password required' });
        }

        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        const { data: restaurant } = await supabase
            .from('restaurants')
            .select('id, reset_token, reset_token_expires')
            .eq('reset_token', token)
            .single();

        if (!restaurant) {
            return res.status(400).json({ error: 'Invalid or expired token' });
        }

        if (!restaurant.reset_token_expires || new Date(restaurant.reset_token_expires) < new Date()) {
            return res.status(400).json({ error: 'Invalid or expired token' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        await supabase
            .from('restaurants')
            .update({ password: hashedPassword, reset_token: null, reset_token_expires: null })
            .eq('id', restaurant.id);

        res.json({ message: 'Password reset successfully' });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({ error: 'Failed to reset password' });
    }
});

export default router;
