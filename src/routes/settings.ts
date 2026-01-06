import { Router, Response } from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import supabase from '../config/supabase';
import vapiService from '../services/vapi.service';

const router = Router();
router.use(authenticateToken);

/**
 * Get restaurant settings
 */
router.get('/', async (req: AuthRequest, res: Response) => {
    try {
        const restaurantId = req.user!.restaurantId;

        const { data: restaurant, error } = await supabase
            .from('restaurants')
            .select('*')
            .eq('id', restaurantId)
            .single();

        if (error || !restaurant) {
            return res.status(404).json({ error: 'Restaurant not found' });
        }

        // Remove sensitive data
        const { password, verification_token, ...settings } = restaurant;

        res.json({ settings });
    } catch (error: any) {
        console.error('Get settings error:', error);
        res.status(500).json({ error: 'Failed to fetch settings' });
    }
});

/**
 * Update restaurant settings
 */
router.put('/', async (req: AuthRequest, res: Response) => {
    try {
        const restaurantId = req.user!.restaurantId;
        const updates = req.body;

        // Don't allow updating certain fields
        delete updates.id;
        delete updates.password;
        delete updates.email;
        delete updates.verification_token;
        delete updates.vapi_phone_id;
        delete updates.vapi_assistant_id;

        const { data: restaurant, error } = await supabase
            .from('restaurants')
            .update(updates)
            .eq('id', restaurantId)
            .select()
            .single();

        if (error) {
            console.error('Database error:', error);
            return res.status(500).json({ error: 'Failed to update settings' });
        }

        // If restaurant details changed, update VAPI assistant
        if (restaurant.vapi_assistant_id) {
            try {
                await vapiService.updateAssistant(restaurant.vapi_assistant_id, restaurant);
            } catch (vapiError) {
                console.error('VAPI update error:', vapiError);
                // Don't fail the request if VAPI update fails
            }
        }

        const { password, verification_token, ...settings } = restaurant;
        res.json({ message: 'Settings updated successfully', settings });
    } catch (error: any) {
        console.error('Update settings error:', error);
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

/**
 * Retry VAPI provisioning for restaurants with errors
 */
router.post('/retry-vapi', async (req: AuthRequest, res: Response) => {
    try {
        const restaurantId = req.user!.restaurantId;

        // Get restaurant details
        const { data: restaurant, error: findError } = await supabase
            .from('restaurants')
            .select('*')
            .eq('id', restaurantId)
            .single();

        if (findError || !restaurant) {
            return res.status(404).json({ error: 'Restaurant not found' });
        }

        // Check if already provisioned
        if (restaurant.vapi_phone_number && restaurant.vapi_assistant_id) {
            return res.status(400).json({ error: 'VAPI already configured' });
        }

        // Update status to provisioning
        await supabase
            .from('restaurants')
            .update({ status: 'provisioning' })
            .eq('id', restaurantId);

        // Provision VAPI
        try {
            console.log('🚀 Retrying VAPI provisioning for restaurant:', restaurant.name);

            // Create assistant first
            const assistant = await vapiService.createAssistant(restaurant);
            console.log('✅ VAPI Assistant created:', assistant.id);

            // Create phone number
            const phoneNumber = await vapiService.createPhoneNumber(restaurant.id, restaurant.name);
            console.log('✅ VAPI Phone number created:', phoneNumber.number || phoneNumber.id);

            // Link assistant to phone number
            await vapiService.linkAssistantToPhone(phoneNumber.id, assistant.id);
            console.log('✅ Assistant linked to phone number');

            // Generate BCC email (use gmail.com as default if EMAIL_DOMAIN not set)
            const emailDomain = process.env.EMAIL_DOMAIN || 'gmail.com';
            const bccEmail = `bcc+r-${restaurant.id}@${emailDomain}`;

            // Update restaurant with VAPI details
            await supabase
                .from('restaurants')
                .update({
                    vapi_phone_number: phoneNumber.number || phoneNumber.id, // Use actual number if available
                    vapi_phone_id: phoneNumber.id,
                    vapi_assistant_id: assistant.id,
                    bcc_email: bccEmail,
                    status: 'active'
                })
                .eq('id', restaurant.id);

            console.log('✅ VAPI provisioning completed successfully');

            res.json({
                message: 'VAPI provisioning successful!',
                phoneNumber: phoneNumber.number || 'Phone ID: ' + phoneNumber.id,
                assistantId: assistant.id,
                bccEmail
            });

        } catch (vapiError: any) {
            console.error('❌ VAPI provisioning error:', vapiError);

            // Update status to error
            await supabase
                .from('restaurants')
                .update({ status: 'error' })
                .eq('id', restaurant.id);

            return res.status(500).json({
                error: 'VAPI provisioning failed. Please contact support.',
                details: vapiError.message
            });
        }

    } catch (error: any) {
        console.error('Retry VAPI error:', error);
        res.status(500).json({ error: 'Failed to retry VAPI provisioning' });
    }
});

export default router;
