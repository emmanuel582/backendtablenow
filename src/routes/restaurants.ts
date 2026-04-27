import { Router, Response } from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/handlers';
import { UpdateRestaurantLanguageSchema } from '../types/schemas';
import supabase from '../config/supabase';
import logger from '../lib/logger';
import { DatabaseError, NotFoundError } from '../lib/errors';

const router = Router();
router.use(authenticateToken);

/**
 * PATCH /api/restaurants/me/language
 *
 * Met à jour la langue préférée du restaurant (utilisée pour les emails de
 * notification adressés au restaurant et pour le dashboard). Body : { language: 'fr' | 'en' }.
 */
router.patch('/me/language', validate(UpdateRestaurantLanguageSchema), async (req: AuthRequest, res: Response, next) => {
    try {
        const restaurantId = req.user!.restaurantId;
        const { language } = req.body;

        const { data, error } = await supabase
            .from('restaurants')
            .update({ language })
            .eq('id', restaurantId)
            .select('id, language')
            .single();

        if (error) throw new DatabaseError('Failed to update restaurant language', error);
        if (!data) throw new NotFoundError('Restaurant');

        logger.child({ restaurantId, language }).info('Restaurant language updated');
        res.json({ message: 'Language updated', language: data.language });
    } catch (err) { next(err); }
});

export default router;
