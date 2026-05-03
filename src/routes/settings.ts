import { Router, Response } from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import supabase from '../config/supabase';
import vapiService from '../services/vapi.service';
import { provisionVapi } from './auth';
import logger from '../lib/logger';

const router = Router();
router.use(authenticateToken);

// ── Allowed fields for PUT /settings ─────────────────────────────────────────
// Explicit allowlist — only these fields may be updated via this route.
const SETTINGS_ALLOWLIST = new Set([
    'name', 'owner_name', 'phone', 'address', 'cuisine_type',
    'opening_hours', 'services', 'capacity', 'special_features',
    'faq_text', 'description', 'website', 'language',
]);

// ── GET /settings ─────────────────────────────────────────────────────────────

router.get('/', async (req: AuthRequest, res: Response) => {
    try {
        const { data: restaurant, error } = await supabase
            .from('restaurants').select('*').eq('id', req.user!.restaurantId).single();

        if (error || !restaurant) return res.status(404).json({ error: 'Restaurant not found' });

        const { password, verification_token, ...settings } = restaurant;
        res.json({ settings });
    } catch (error: any) {
        logger.error({ error }, 'Get settings error');
        res.status(500).json({ error: 'Failed to fetch settings' });
    }
});

// ── PUT /settings ─────────────────────────────────────────────────────────────

router.put('/', async (req: AuthRequest, res: Response) => {
    try {
        const restaurantId = req.user!.restaurantId;

        // Allowlist: only accept fields that are explicitly permitted
        const updates: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(req.body)) {
            if (SETTINGS_ALLOWLIST.has(key)) updates[key] = value;
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        const { data: restaurant, error } = await supabase
            .from('restaurants').update(updates).eq('id', restaurantId).select().single();

        if (error) {
            logger.error({ error }, 'Settings update DB error');
            return res.status(500).json({ error: 'Failed to update settings' });
        }

        // Sync VAPI assistant if relevant fields changed
        if (restaurant.vapi_assistant_id) {
            try {
                const updated = await vapiService.updateAssistant(restaurant.vapi_assistant_id, restaurant);
                if (updated === null) {
                    // Assistant no longer exists on VAPI — clear stale ID
                    logger.warn({ assistantId: restaurant.vapi_assistant_id }, '🧹 Clearing stale VAPI assistant ID');
                    await supabase.from('restaurants').update({ vapi_assistant_id: null }).eq('id', restaurantId);
                    restaurant.vapi_assistant_id = null;
                }
            } catch (vapiError) {
                logger.error({ vapiError }, 'VAPI assistant update error');
                // Non-fatal — don't fail the settings update
            }
        }

        const { password, verification_token, ...settings } = restaurant;
        res.json({ message: 'Settings updated successfully', settings });
    } catch (error: any) {
        logger.error({ error }, 'Update settings error');
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

// ── POST /settings/retry-vapi ─────────────────────────────────────────────────

router.post('/retry-vapi', async (req: AuthRequest, res: Response) => {
    try {
        const restaurantId = req.user!.restaurantId;

        const { data: restaurant, error: findError } = await supabase
            .from('restaurants').select('*').eq('id', restaurantId).single();

        if (findError || !restaurant) return res.status(404).json({ error: 'Restaurant not found' });

        // If already provisioned, verify it still exists on VAPI
        if (restaurant.vapi_phone_number && restaurant.vapi_assistant_id) {
            try {
                const exists = await vapiService.checkAssistantExists(restaurant.vapi_assistant_id);
                if (exists) return res.status(400).json({ error: 'VAPI already configured and active.' });
                logger.warn({ assistantId: restaurant.vapi_assistant_id }, '⚠️ Assistant not found on VAPI — re-provisioning');
            } catch {
                logger.warn('⚠️ Could not verify assistant existence — proceeding');
            }
        }

        await supabase.from('restaurants').update({ status: 'provisioning' }).eq('id', restaurantId);

        try {
            const { assistantId, phoneNumber, bccEmail } = await provisionVapi(restaurant);
            res.json({
                message: 'VAPI provisioning successful!',
                phoneNumber,
                assistantId,
                bccEmail,
            });
        } catch (vapiError: any) {
            logger.error({ vapiError }, '❌ VAPI retry provisioning error');
            await supabase.from('restaurants').update({ status: 'error' }).eq('id', restaurant.id);
            return res.status(500).json({ error: 'VAPI provisioning failed. Please contact support.', details: vapiError.message });
        }
    } catch (error: any) {
        logger.error({ error }, 'Retry VAPI error');
        res.status(500).json({ error: 'Failed to retry VAPI provisioning' });
    }
});

export default router;
