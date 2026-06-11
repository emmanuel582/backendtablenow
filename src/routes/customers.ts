import { Router, Request, Response } from 'express';
import logger from '../lib/logger';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import supabase from '../config/supabase';

const router = Router();

// ─────────────────────────────────────────────
// DELETE /api/bookings/:id
// Soft delete — status = cancelled
// 🔒 Requires authentication
// ─────────────────────────────────────────────
router.delete('/bookings/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
    const restaurantId = req.user!.restaurantId;

    // Ensure the booking belongs to the authenticated restaurant
    const { data: existing, error: findError } = await supabase
        .from('bookings')
        .select('id')
        .eq('id', req.params.id)
        .eq('restaurant_id', restaurantId)
        .single();

    if (findError || !existing) {
        return res.status(404).json({ error: 'Réservation introuvable' });
    }

    const { data, error } = await supabase
        .from('bookings')
        .update({ status: 'cancelled' })
        .eq('id', req.params.id)
        .eq('restaurant_id', restaurantId)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: 'Réservation annulée', booking: data });
});

// ─────────────────────────────────────────────
// GET /api/customers?phone=+336...
// Profil complet d'un convive + historique
// 🔒 Auth requise + scoping restaurant : le restaurant_id vient du token
//    (jamais de la query) — impossible de lire les clients d'un autre restaurant.
// ─────────────────────────────────────────────
router.get('/customers', authenticateToken, async (req: AuthRequest, res: Response) => {
    const restaurantId = req.user!.restaurantId;
    const { phone } = req.query as { phone?: string };

    if (!phone) {
        return res.status(400).json({ error: 'Paramètre phone requis' });
    }

    const { data, error } = await supabase
        .from('customers')
        .select('*, bookings(*)')
        .eq('phone', phone)
        .eq('restaurant_id', restaurantId)
        .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Client introuvable' });
    res.json(data);
});

// ─────────────────────────────────────────────
// PATCH /api/customers/:id
// Mettre à jour allergies, préférences, notes
// 🔒 Auth requise + scoping restaurant : un restaurant ne peut modifier que SES
//    clients. Un client d'un autre restaurant ne matche aucune ligne → 404 (pas
//    d'écriture cross-tenant, pas de fuite d'existence).
// ─────────────────────────────────────────────
router.patch('/customers/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
    const restaurantId = req.user!.restaurantId;
    const { name, email, allergies, preferences, notes } = req.body;

    const updates: Record<string, unknown> = {};
    if (name !== undefined)        updates.name = name;
    if (email !== undefined)       updates.email = email;
    if (allergies !== undefined)   updates.allergies = allergies;
    if (preferences !== undefined) updates.preferences = preferences;
    if (notes !== undefined)       updates.notes = notes;

    if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'Aucun champ modifiable fourni' });
    }

    // L'update est borné au restaurant authentifié (filtre restaurant_id) : un
    // client appartenant à un autre restaurant ne matche aucune ligne.
    const { data, error } = await supabase
        .from('customers')
        .update(updates)
        .eq('id', req.params.id)
        .eq('restaurant_id', restaurantId)
        .select()
        .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Client introuvable' });
    res.json(data);
});

// ─────────────────────────────────────────────
// POST /api/internal/mark-noshows
// Marquer no_show — protégé par INTERNAL_SECRET
// Cron VPS : 0 * * * *
// ─────────────────────────────────────────────
router.post('/internal/mark-noshows', async (req: Request, res: Response) => {
    const secret = req.headers['x-internal-secret'];
    if (secret !== process.env.INTERNAL_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { data, error } = await supabase.rpc('mark_noshows');
    if (error) return res.status(500).json({ error: error.message });

    const count = typeof data === 'number' ? data : 0;
    logger.info({ count }, '[no-show cron] reservations marked no_show');
    res.json({ marked: count });
});

export default router;
