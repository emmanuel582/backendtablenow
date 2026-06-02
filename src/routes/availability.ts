import { Router, Request, Response } from 'express';
import supabase from '../config/supabase';
import { createBooking } from '../services/booking.service';
import logger from '../lib/logger';

const router = Router();

// ──────────────────────────────────────────────
// GET /api/availability
// Créneaux disponibles pour une date + nb couverts
// Query: restaurant_id, date (YYYY-MM-DD), covers
// ──────────────────────────────────────────────
router.get('/', async (req: Request, res: Response) => {
    const { restaurant_id, date, covers = '2' } = req.query as Record<string, string>;

    if (!restaurant_id || !date) {
        return res.status(400).json({ error: 'restaurant_id et date sont requis' });
    }

    // 1. Vérifie si fermé ce jour
    const { data: closed } = await supabase
        .from('closed_dates')
        .select('reason')
        .eq('restaurant_id', restaurant_id)
        .eq('closed_on', date)
        .maybeSingle();

    if (closed) {
        return res.json({
            available: false,
            reason: 'closed',
            message: closed.reason || 'Le restaurant est fermé ce jour-là.',
            slots: []
        });
    }

    // 2. Appelle la RPC
    const { data: slots, error } = await supabase.rpc('get_available_slots', {
        p_restaurant_id: restaurant_id,
        p_date: date,
        p_covers: parseInt(covers, 10)
    });

    if (error) {
        logger.error({ err: error }, '[availability] get_available_slots error');
        return res.status(500).json({ error: 'Erreur serveur' });
    }

    const availableSlots = (slots as any[]).filter(s => s.available);

    return res.json({
        date,
        covers: parseInt(covers, 10),
        available: availableSlots.length > 0,
        slots: availableSlots.map(s => ({
            time: s.slot_time.slice(0, 5),       // "12:00"
            datetime: s.slot_datetime,
            remaining: s.remaining,
            max: s.max_covers
        }))
    });
});

// ──────────────────────────────────────────────
// POST /api/availability/validate
// Validation atomique juste avant de confirmer la résa.
// Appelé par le voice agent EN DERNIER avant POST /api/bookings.
// Body: { restaurant_id, datetime (ISO), covers }
// ──────────────────────────────────────────────
router.post('/validate', async (req: Request, res: Response) => {
    const { restaurant_id, datetime, covers } = req.body;

    if (!restaurant_id || !datetime || !covers) {
        return res.status(400).json({ error: 'Champs manquants' });
    }

    const dt = new Date(datetime);
    const date = dt.toISOString().slice(0, 10);
    const hhmm = dt.toTimeString().slice(0, 5);

    const { data: slots, error } = await supabase.rpc('get_available_slots', {
        p_restaurant_id: restaurant_id,
        p_date: date,
        p_covers: parseInt(covers, 10)
    });

    if (error) return res.status(500).json({ error: 'Erreur serveur' });

    const match = (slots as any[]).find(s => s.slot_time.slice(0, 5) === hhmm);

    if (!match) {
        return res.json({ valid: false, reason: 'Créneau inexistant pour ce restaurant' });
    }

    if (!match.available) {
        return res.json({
            valid: false,
            reason: 'Complet',
            remaining: match.remaining,
            requested: covers
        });
    }

    return res.json({
        valid: true,
        remaining: match.remaining,
        datetime: match.slot_datetime
    });
});

// ──────────────────────────────────────────────
// GET /api/availability/next
// Prochain créneau libre à partir d'une date.
// Query: restaurant_id, from (YYYY-MM-DD), covers, max_days (défaut 14)
// ──────────────────────────────────────────────
router.get('/next', async (req: Request, res: Response) => {
    const { restaurant_id, from, covers = '2', max_days = '14' } = req.query as Record<string, string>;

    if (!restaurant_id || !from) {
        return res.status(400).json({ error: 'restaurant_id et from sont requis' });
    }

    const start = new Date(from);
    const coversN = parseInt(covers, 10);
    const maxDays = parseInt(max_days, 10);

    for (let i = 0; i < maxDays; i++) {
        const d = new Date(start);
        d.setDate(d.getDate() + i);
        const date = d.toISOString().slice(0, 10);

        // Vérifie jour fermé
        const { data: closed } = await supabase
            .from('closed_dates')
            .select('id')
            .eq('restaurant_id', restaurant_id)
            .eq('closed_on', date)
            .maybeSingle();

        if (closed) continue;

        const { data: slots } = await supabase.rpc('get_available_slots', {
            p_restaurant_id: restaurant_id,
            p_date: date,
            p_covers: coversN
        });

        const first = (slots as any[] || []).find(s => s.available);

        if (first) {
            return res.json({
                found: true,
                date,
                time: first.slot_time.slice(0, 5),
                datetime: first.slot_datetime,
                remaining: first.remaining
            });
        }
    }

    return res.json({
        found: false,
        message: `Aucun créneau disponible dans les ${maxDays} prochains jours.`
    });
});

// ──────────────────────────────────────────────
// POST /api/availability/bookings (deprecated alias)
// DEPRECATED: Use POST /api/bookings instead
// Kept for backward compatibility, delegates to unified endpoint
// Body: restaurant_id, phone, name?, email?,
//       booked_for (ISO), covers, special_requests?, source?
// ──────────────────────────────────────────────
router.post('/bookings', async (req: Request, res: Response) => {
    const { restaurant_id, phone, name, email, booked_for, covers, special_requests, source = 'web' } = req.body;

    const missing = ['restaurant_id', 'phone', 'booked_for', 'covers'].filter(k => !req.body[k]);
    if (missing.length) {
        return res.status(400).json({ error: 'Champs requis manquants', missing });
    }

    try {
        const log = logger.child({ restaurant_id, path: 'POST /availability/bookings (deprecated)' });

        // Validate slot availability
        const bookedDate = booked_for.slice(0, 10);
        const hhmm = new Date(booked_for).toTimeString().slice(0, 5);
        const { data: slots } = await supabase.rpc('get_available_slots', {
            p_restaurant_id: restaurant_id,
            p_date: bookedDate,
            p_covers: parseInt(covers, 10)
        });

        const targetSlot = (slots as any[] || []).find(s => s.slot_time.slice(0, 5) === hhmm);
        if (targetSlot && !targetSlot.available) {
            return res.status(409).json({ error: 'Créneau complet', remaining: targetSlot.remaining });
        }

        // Delegate to unified createBooking (via availability endpoint)
        const booking = await createBooking({
            restaurant_id,
            date: bookedDate,
            time: hhmm,
            covers: parseInt(covers, 10),
            guest_name: name || 'Guest',
            guest_email: email,
            guest_phone: phone,
            special_requests: special_requests || null,
            source: source as 'manual' | 'phone' | 'web'
        });

        log.info({ bookingId: booking.id }, 'Booking created via deprecated endpoint');
        return res.json({ success: true, booking });
    } catch (err: any) {
        logger.error({ err }, '[POST /availability/bookings] error');
        return res.status(500).json({ error: err.message });
    }
});

export default router;
