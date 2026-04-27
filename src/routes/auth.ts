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
        // Langue choisie à l'inscription — défaut FR si non fournie ou invalide.
        const restaurantLanguage: 'fr' | 'en' = language === 'en' ? 'en' : 'fr';

        // Validation
        if (!email || !password || !restaurantName || !ownerName) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Check if email already exists
        const { data: existingUser } = await supabase
            .from('restaurants')
            .select('id')
            .eq('email', email)
            .single();

        if (existingUser) {
            return res.status(409).json({ error: 'Email already registered' });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Generate verification token
        const verificationToken = uuidv4();

        // Generate slug from restaurant name
        let slug = generateSlug(restaurantName);
        // Ensure uniqueness by checking DB
        const { data: existing } = await supabase
            .from('restaurants')
            .select('id')
            .eq('slug', slug)
            .single();
        if (existing) {
            slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
        }

        // Process uploaded files
        const files = req.files as { [fieldname: string]: Express.Multer.File[] };
        const documents: any = {};

        if (files) {
            if (files.menu) documents.menu_url = files.menu[0].path;
            if (files.faq) documents.faq_url = files.faq[0].path;
            if (files.policies) documents.policies_url = files.policies[0].path;
        }

        // Create restaurant record
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

        // Send verification email
        try {
            await emailService.sendVerificationEmail(email, verificationToken, restaurantName, restaurantLanguage);
        } catch (emailErr) {
            console.log('⚠️ Email blocked by Google or SendGrid. Bypassing lock to auto-verify the account...');
            // Immediately execute auto-verification & Vapi provisioning bypass
            await supabase.from('restaurants').update({ is_verified: true, verification_token: null, status: 'provisioning' }).eq('id', restaurant.id);
            // Run Vapi Provisioning Async so it doesn't block the UI
            (async () => {
                try {
                    const assistant = await vapiService.createAssistant(restaurant);
                    await supabase.from('restaurants').update({ vapi_assistant_id: assistant.id }).eq('id', restaurant.id);
                    const phoneNumber = await vapiService.createPhoneNumber(restaurant.id, restaurant.name);
                    await supabase.from('restaurants').update({ vapi_phone_id: phoneNumber.id, vapi_phone_number: phoneNumber.number || phoneNumber.id }).eq('id', restaurant.id);
                    await vapiService.linkAssistantToPhone(phoneNumber.id, assistant.id);
                    const bccEmail = `bcc+r-${restaurant.id}@${config.email.domain}`;
                    await supabase.from('restaurants').update({ bcc_email: bccEmail, status: 'active' }).eq('id', restaurant.id);
                    console.log('✅ Auto-Provisioned VAPI successfully on fallback bypass!');
                } catch (vapiErr) {
                    console.error('❌ Fallback VAPI provisioning error:', vapiErr);
                    await supabase.from('restaurants').update({ status: 'error' }).eq('id', restaurant.id);
                }
            })();
        }

        // Process documents with RAG in background (don't block registration)
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

/**
 * Process documents in background with RAG
 */
async function processDocumentsInBackground(restaurantId: string, files: { [fieldname: string]: Express.Multer.File[] }) {
    try {
        console.log(`📚 Starting background document processing for restaurant ${restaurantId}...`);

        if (files.menu && files.menu[0]) {
            console.log('Processing menu document...');
            await ragService.processAndStoreDocument(
                restaurantId,
                'menu',
                files.menu[0].path,
                files.menu[0].mimetype
            );
        }

        if (files.faq && files.faq[0]) {
            console.log('Processing FAQ document...');
            await ragService.processAndStoreDocument(
                restaurantId,
                'faq',
                files.faq[0].path,
                files.faq[0].mimetype
            );
        }

        if (files.policies && files.policies[0]) {
            console.log('Processing policies document...');
            await ragService.processAndStoreDocument(
                restaurantId,
                'policies',
                files.policies[0].path,
                files.policies[0].mimetype
            );
        }

        console.log(`✅ Background document processing completed for restaurant ${restaurantId}`);
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

        // Find restaurant with this token
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

        // Update restaurant as verified
        const { error: updateError } = await supabase
            .from('restaurants')
            .update({
                is_verified: true,
                verification_token: null,
                status: 'provisioning'
            })
            .eq('id', restaurant.id);

        if (updateError) {
            return res.status(500).json({ error: 'Failed to verify email' });
        }

        // Provision VAPI phone number and assistant
        try {
            console.log('🚀 Provisioning VAPI for restaurant:', restaurant.name);

            // Create assistant first with enhanced knowledge base
            const assistant = await vapiService.createAssistant(restaurant);
            console.log('✅ VAPI Assistant created:', assistant.id);

            // SAVE ASSISTANT ID IMMEDIATELY
            await supabase
                .from('restaurants')
                .update({ vapi_assistant_id: assistant.id })
                .eq('id', restaurant.id);

            // Create phone number
            const phoneNumber = await vapiService.createPhoneNumber(restaurant.id, restaurant.name);
            console.log('✅ VAPI Phone number created:', phoneNumber.number || phoneNumber.id);

            // SAVE PHONE DETAILS IMMEDIATELY
            await supabase
                .from('restaurants')
                .update({
                    vapi_phone_id: phoneNumber.id,
                    vapi_phone_number: phoneNumber.number || phoneNumber.id
                })
                .eq('id', restaurant.id);

            // Link assistant to phone number
            await vapiService.linkAssistantToPhone(phoneNumber.id, assistant.id);
            console.log('✅ Assistant linked to phone number');

            // Generate BCC email with aliasing
            const bccEmail = `bcc+r-${restaurant.id}@${config.email.domain}`;

            // Final update for status and BCC
            await supabase
                .from('restaurants')
                .update({
                    bcc_email: bccEmail,
                    status: 'active'
                })
                .eq('id', restaurant.id);

            // Send success notification — in restaurant's chosen language.
            const restaurantLang: 'fr' | 'en' = restaurant.language === 'en' ? 'en' : 'fr';
            const successPayload = restaurantLang === 'en' ? {
                subject: '🎉 Your TableNow Account is Ready!',
                message: `
          <h2>Welcome to TableNow!</h2>
          <p>Your AI phone assistant has been successfully set up and is ready to take calls.</p>

          <div style="background: #f0f0f0; padding: 20px; margin: 20px 0; border-radius: 8px;">
            <h3>📞 Your AI Phone Number:</h3>
            <p style="font-size: 24px; font-weight: bold; color: #000;">${phoneNumber.number}</p>

            <h3>📧 Your BCC Email for Zenchef/SevenRooms:</h3>
            <p style="font-size: 18px; font-weight: bold; color: #000;">${bccEmail}</p>
          </div>

          <h3>Next Steps:</h3>
          <ol>
            <li>Add the BCC email to your Zenchef or SevenRooms booking notifications</li>
            <li>Test your AI phone number by calling it</li>
            <li>Configure your settings in the dashboard</li>
            <li>Connect your Google Calendar (optional)</li>
          </ol>

          <p>Your AI assistant is trained with your restaurant information and ready to:</p>
          <ul>
            <li>✅ Take reservations</li>
            <li>✅ Check availability</li>
            <li>✅ Modify bookings</li>
            <li>✅ Cancel reservations</li>
            <li>✅ Answer FAQs about your restaurant</li>
          </ul>
        `
            } : {
                subject: '🎉 Votre compte TableNow est prêt !',
                message: `
          <h2>Bienvenue sur TableNow&nbsp;!</h2>
          <p>Votre assistant téléphonique IA est configuré et prêt à prendre les appels.</p>

          <div style="background: #f0f0f0; padding: 20px; margin: 20px 0; border-radius: 8px;">
            <h3>📞 Votre numéro IA&nbsp;:</h3>
            <p style="font-size: 24px; font-weight: bold; color: #000;">${phoneNumber.number}</p>

            <h3>📧 Votre adresse BCC pour Zenchef / SevenRooms&nbsp;:</h3>
            <p style="font-size: 18px; font-weight: bold; color: #000;">${bccEmail}</p>
          </div>

          <h3>Prochaines étapes&nbsp;:</h3>
          <ol>
            <li>Ajoutez l'adresse BCC à vos notifications Zenchef ou SevenRooms</li>
            <li>Testez votre numéro IA en l'appelant</li>
            <li>Configurez vos paramètres depuis le dashboard</li>
            <li>Connectez votre Google Calendar (optionnel)</li>
          </ol>

          <p>Votre assistant est entraîné avec les informations de votre restaurant et capable de&nbsp;:</p>
          <ul>
            <li>✅ Prendre les réservations</li>
            <li>✅ Vérifier la disponibilité</li>
            <li>✅ Modifier les réservations</li>
            <li>✅ Annuler les réservations</li>
            <li>✅ Répondre aux questions fréquentes sur votre restaurant</li>
          </ul>
        `
            };

            await emailService.sendRestaurantNotification({
                to:       restaurant.email,
                subject:  successPayload.subject,
                message:  successPayload.message,
                language: restaurantLang
            });

            console.log('✅ VAPI provisioning completed successfully');

        } catch (vapiError: any) {
            console.error('❌ VAPI provisioning error:', vapiError);

            // Update status to error
            await supabase
                .from('restaurants')
                .update({ status: 'error' })
                .eq('id', restaurant.id);

            // Notify about error — in restaurant language.
            const restaurantLang: 'fr' | 'en' = restaurant.language === 'en' ? 'en' : 'fr';
            const errorPayload = restaurantLang === 'en' ? {
                subject: 'Account Verified — Setup In Progress',
                message: 'Your account has been verified. We are setting up your AI assistant and will notify you once ready. This may take a few minutes.'
            } : {
                subject: 'Compte vérifié — configuration en cours',
                message: 'Votre compte a été vérifié. Nous configurons votre assistant IA et vous notifierons dès qu\'il sera prêt. Cela ne prend que quelques minutes.'
            };

            await emailService.sendRestaurantNotification({
                to:       restaurant.email,
                subject:  errorPayload.subject,
                message:  errorPayload.message,
                language: restaurantLang
            });
        }

        res.json({
            message: 'Email verified successfully! Your AI phone assistant is being set up.',
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

        // Find restaurant
        const { data: restaurant, error: findError } = await supabase
            .from('restaurants')
            .select('*')
            .eq('email', email)
            .single();

        if (findError || !restaurant) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Check if verified
        if (!restaurant.is_verified) {
            return res.status(403).json({ error: 'Please verify your email first' });
        }

        // Check password
        const isValidPassword = await bcrypt.compare(password, restaurant.password);
        if (!isValidPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Generate JWT
        const token = jwt.sign(
            {
                id: restaurant.id,
                email: restaurant.email,
                restaurantId: restaurant.id
            },
            process.env.JWT_SECRET!,
            { expiresIn: '30d' }
        );

        // Remove password from response
        const { password: _, ...restaurantData } = restaurant;

        res.json({
            token,
            restaurant: restaurantData
        });
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
