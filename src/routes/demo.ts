import { Router, Request, Response } from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { config } from '../lib/config';
import demoService from '../services/demo.service';
import logger from '../lib/logger';

const router = Router();

/**
 * POST /api/demo/seed
 * Charge un jeu de données de démonstration pour le restaurant authentifié.
 * Query: ?reset=1 pour supprimer les réservations/appels existants avant seed.
 *
 * Peut aussi être appelé avec X-Internal-Secret + body { restaurant_id } (ops).
 */
router.post('/seed', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const reset = req.query.reset === '1' || req.body?.reset === true;
        const stats = await demoService.seedDemoData(req.user!.restaurantId, reset);
        res.json({ success: true, ...stats });
    } catch (err: any) {
        logger.error({ err: err?.message }, 'Demo seed failed');
        res.status(500).json({ error: 'Demo seed failed', detail: err?.message });
    }
});

/** Seed interne (sans JWT) pour scripts / CI — protégé par INTERNAL_SECRET. */
router.post('/seed-internal', async (req: Request, res: Response) => {
    const secret = req.headers['x-internal-secret'];
    if (!secret || secret !== config.auth.internalSecret) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const restaurantId = req.body?.restaurant_id;
    if (!restaurantId) {
        return res.status(400).json({ error: 'restaurant_id required' });
    }

    try {
        const reset = req.body?.reset !== false;
        const stats = await demoService.seedDemoData(restaurantId, reset);
        res.json({ success: true, ...stats });
    } catch (err: any) {
        logger.error({ err: err?.message }, 'Demo seed internal failed');
        res.status(500).json({ error: 'Demo seed failed', detail: err?.message });
    }
});

export default router;
