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
    limits: { fileSize: 10 * 1024 * 1024 },
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
 * Register new restaurant
 */
router.post('/register', upload.fields([
    { name: 'menu', maxCount: 1 },
    { name: 'faq', maxCount: 1 },
    { name: 'policies', maxCount: 1 }
]), async (req: Request, res: Response) => {
    try {
        const {
            email, password, restaurantName, ownerName, phone,
            address, cuisineType, openingHours, specialFeatures, faqText
        } = req.body;

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
            if (files.menu)     documents.menu_url = files.menu[0].path;
            if (files.faq)      documents.faq_url  = files.faq[0].path;
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
            })
            .select()
            .single();

        if (dbError) {
            console.error('Database error:', dbError);
            return res.status(500).json({ error: 'Failed to create account' });
        }

        try {
            await emailService.sendVerificationEmail(email, verificationToken, restaurantName);
        } catch (emailErr) {
            console.log('⚠️ Email blocked. Auto-verifying account...');
            await supabase.from('restaurants')
                .update({ is_verified: true, verification_token: null, status: 'provisioning' })
                .eq('id', restaurant.id);
            (async () => {
                try {
                    const assistant = await vapiService.createAssistant(restaurant);
                    await supabase.from('restaurants').update({ vapi_assistant_id: assistant.id }).eq('id', restaurant.id);
                    const phoneNumber = await vapiService.createPhoneNumber(restaurant.id, restaurant.name);
                    await supabase.from('restaurants').update({ vapi_phone_id: phoneNumber.id, vapi_phone_number: phoneNumber.number || phoneNumber.id }).eq('id', restaurant.id);
                    await vapiService.linkAssistantToPhone(phoneNumber.id, assistant.id);
                    const bccEmail = `bcc+r-${restaurant.id}@${process.env.EMAIL_DOMAIN || 'gmail.com'}`;
                    await supabase.from('restaurants').update({ bcc_email: bccEmail, status: 'active' }).eq('id', restaurant.id);
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
            message: 'Account created successfully. Please verify your email.',
            restaurantId: restaurant.id
        });
    } catch (error: any) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Registration failed' });
    }
});

/**
 * Process documents in background with RAG
 */
async function processDocumentsInBackground(restaurantId: string, files: { [fieldname: string]: Express.Multer.File[] }) {
    try {
        console.log(`📚 Starting background document processing for restaurant ${restaurantId}...`);
        if (files.menu && files.menu[0]) {
            await ragService.processAndStoreDocument(restaurantId, 'menu', files.menu[0].path, files.menu[0].mimetype);
        }
        if (files.faq && files.faq[0]) {
            await ragService.processAndStoreDocument(restaurantId, 'faq', files.faq[0].path, files.faq[0].mimetype);
        }
        if (files.policies && files.policies[0]) {
            await ragService.processAndStoreDocument(restaurantId, 'policies', files.policies[0].path, files.policies[0].mimetype);
        }
        console.log(`✅ Background document processing completed for restaurant ${restaurantId}`);
    } catch (error) {
        console.error('Error in background document processing:', error);
    }
}

/**
 * Verify email and provision VAPI
 * Returns a JWT so the frontend can auto-login and redirect to /onboarding
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
            // Already verified — still return a JWT so the user can log in
            const jwt_token = jwt.sign(
                { id: restaurant.id, email: restaurant.email, restaurantId: restaurant.id },
                process.env.JWT_SECRET!,
                { expiresIn: '30d' }
            );
            return res.json({
                message: 'Email already verified.',
                token: jwt_token,
                status: restaurant.status
            });
        }

        const { error: updateError } = await supabase
            .from('restaurants')
            .update({ is_verified: true, verification_token: null, status: 'provisioning' })
            .eq('id', restaurant.id);

        if (updateError) {
            return res.status(500).json({ error: 'Failed to verify email' });
        }

        // Provision VAPI async — don't block the response
        (async () => {
            try {
                console.log('🚀 Provisioning VAPI for restaurant:', restaurant.name);
                const assistant = await vapiService.createAssistant(restaurant);
                await supabase.from('restaurants').update({ vapi_assistant_id: assistant.id }).eq('id', restaurant.id);
                const phoneNumber = await vapiService.createPhoneNumber(restaurant.id, restaurant.name);
                await supabase.from('restaurants').update({
                    vapi_phone_id: phoneNumber.id,
                    vapi_phone_number: phoneNumber.number || phoneNumber.id
                }).eq('id', restaurant.id);
                await vapiService.linkAssistantToPhone(phoneNumber.id, assistant.id);
                const emailDomain = process.env.EMAIL_DOMAIN || 'gmail.com';
                const bccEmail = `bcc+r-${restaurant.id}@${emailDomain}`;
                await supabase.from('restaurants').update({ bcc_email: bccEmail, status: 'active' }).eq('id', restaurant.id);
                await emailService.sendRestaurantNotification({
                    to: restaurant.email,
                    subject: '🎉 Votre compte TableNow est prêt !',
                    message: `<p>Votre assistant vocal IA est configuré et prêt à prendre des appels.</p><p><strong>Numéro IA :</strong> ${phoneNumber.number}</p><p><strong>Email BCC :</strong> ${bccEmail}</p>`
                });
                console.log('✅ VAPI provisioning completed');
            } catch (vapiError: any) {
                console.error('❌ VAPI provisioning error:', vapiError);
                await supabase.from('restaurants').update({ status: 'error' }).eq('id', restaurant.id);
            }
        })();

        // Generate JWT for auto-login → redirect to /onboarding
        const jwt_token = jwt.sign(
            { id: restaurant.id, email: restaurant.email, restaurantId: restaurant.id },
            process.env.JWT_SECRET!,
            { expiresIn: '30d' }
        );

        res.json({
            message: 'Email vérifié ! Bienvenue dans TableNow.',
            token: jwt_token,
            status: 'provisioning'
        });
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

export default router;
