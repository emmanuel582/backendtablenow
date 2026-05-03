import { Router, Request, Response } from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import supabase from '../config/supabase';
import { normalizeBooking } from '../services/booking.service';
import { DatabaseError } from '../lib/errors';
import logger from '../lib/logger';

const router = Router();

// ─── POST /dashboard/insights/refresh ────────────────────────────────────────
// Called by pg_cron every 10 minutes via Supabase pg_net.
// Protected by INTERNAL_SECRET — no JWT needed.

router.post('/insights/refresh', async (req: Request, res: Response) => {
    const secret = req.headers['x-internal-secret'];
    if (secret !== process.env.INTERNAL_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const today = new Date().toISOString().split('T')[0];

        // Fetch all active restaurants
        const { data: restaurants, error: rErr } = await supabase
            .from('restaurants')
            .select('id, capacity, opening_hours')
            .eq('status', 'active');

        if (rErr) throw rErr;

        let refreshed = 0;

        for (const restaurant of (restaurants || [])) {
            try {
                const rid = restaurant.id;
                const totalCapacity = restaurant.capacity || 40;

                // Confirmed bookings today
                const { data: todayBookings } = await supabase
                    .from('bookings')
                    .select('*')
                    .eq('restaurant_id', rid)
                    .eq('status', 'confirmed')
                    .or(`booking_date.eq.${today},booked_for.gte.${today}T00:00:00.and.booked_for.lte.${today}T23:59:59`);

                const confirmedCovers = (todayBookings || []).reduce((s: number, b: any) => s + (b.party_size || b.covers || 0), 0);
                const confirmedReservations = (todayBookings || []).length;
                const occupancyRate = totalCapacity > 0 ? Math.round((confirmedCovers / totalCapacity) * 100) / 100 : 0;

                // Calls today
                const { data: todayCalls } = await supabase
                    .from('call_logs')
                    .select('*')
                    .eq('restaurant_id', rid)
                    .gte('created_at', `${today}T00:00:00`)
                    .lte('created_at', `${today}T23:59:59`);

                const calls = todayCalls || [];
                const abandonedCalls = calls.filter((c: any) => (c.duration || 0) < 15 || c.status === 'missed' || c.status === 'failed').length;
                const unplacedRequests = calls.filter((c: any) => (c.duration || 0) > 20 && c.reservation_booked === false).length;

                // Peak unplaced hour
                const peakBuckets: Record<number, number> = {};
                calls.filter((c: any) => c.reservation_booked === false && (c.duration || 0) > 20)
                    .forEach((c: any) => { const h = new Date(c.created_at).getHours(); peakBuckets[h] = (peakBuckets[h] || 0) + 1; });

                const peakUnplacedTime = Object.keys(peakBuckets).length > 0
                    ? `${Object.entries(peakBuckets).sort((a, b) => b[1] - a[1])[0][0]}h`
                    : null;

                // Slot analysis
                const dayOfWeek = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][new Date().getDay()];
                const todayHours = restaurant.opening_hours?.[dayOfWeek];
                const slotBuckets: Record<string, number> = {};

                if (todayHours?.open) {
                    const startH = parseInt((todayHours.from || '12:00').split(':')[0]);
                    const endH   = parseInt((todayHours.to   || '23:00').split(':')[0]);
                    for (let h = startH; h < endH; h++) {
                        for (const m of [0, 30]) slotBuckets[`${h}h${m === 30 ? '30' : '00'}`] = 0;
                    }
                    (todayBookings || []).forEach((b: any) => {
                        const dt = b.booked_for || (b.booking_date && b.booking_time ? `${b.booking_date}T${b.booking_time}` : null);
                        if (!dt) return;
                        const d = new Date(dt);
                        const h = d.getHours(); const m = d.getMinutes() >= 30 ? 30 : 0;
                        const label = `${h}h${m === 30 ? '30' : '00'}`;
                        if (slotBuckets[label] !== undefined) slotBuckets[label]++;
                    });
                }

                const slotEntries = Object.entries(slotBuckets).sort((a, b) => a[1] - b[1]);
                const bestSlotTime   = slotEntries[0]?.[0] || null;
                const lowestSlotTime = slotEntries[0]?.[0] || null;

                // Upsert into insights_cache
                await supabase.from('insights_cache').upsert({
                    restaurant_id: rid,
                    date: today,
                    occupancy_rate: occupancyRate,
                    lowest_slot_time: lowestSlotTime,
                    unplaced_requests: unplacedRequests,
                    peak_unplaced_time: peakUnplacedTime,
                    confirmed_reservations: confirmedReservations,
                    abandoned_calls: abandonedCalls,
                    best_slot_time: bestSlotTime,
                    computed_at: new Date().toISOString(),
                }, { onConflict: 'restaurant_id,date' });

                refreshed++;
            } catch (err) {
                logger.error({ err, restaurantId: restaurant.id }, 'Failed to refresh insights for restaurant');
            }
        }

        logger.info({ refreshed, today }, '✅ Insights cache refreshed');
        res.json({ refreshed, date: today });
    } catch (err: any) {
        logger.error({ err }, 'Insights refresh error');
        res.status(500).json({ error: 'Refresh failed' });
    }
});

router.use(authenticateToken);

// ─── GET /dashboard/stats ─────────────────────────────────────────────────────

router.get('/stats', async (req: AuthRequest, res: Response, next) => {
    try {
        const restaurantId = req.user!.restaurantId;
        const { startDate, endDate } = req.query as Record<string, string>;

        let bookingsQuery = supabase
            .from('bookings')
            .select('*, customers(name, email, phone)', { count: 'exact' })
            .eq('restaurant_id', restaurantId)
            .order('created_at', { ascending: false });

        if (startDate) bookingsQuery = bookingsQuery.or(
            `booking_date.gte.${startDate},booked_for.gte.${startDate}T00:00:00`
        );
        if (endDate) bookingsQuery = bookingsQuery.or(
            `booking_date.lte.${endDate},booked_for.lte.${endDate}T23:59:59`
        );

        const { data: rawBookings, count: totalBookings, error: bErr } = await bookingsQuery;
        if (bErr) throw new DatabaseError('Failed to fetch bookings', bErr);

        const bookings = (rawBookings || []).map(normalizeBooking);

        let callsQuery = supabase
            .from('call_logs')
            .select('*', { count: 'exact' })
            .eq('restaurant_id', restaurantId)
            .order('created_at', { ascending: false });

        if (startDate) callsQuery = callsQuery.gte('created_at', startDate);
        if (endDate)   callsQuery = callsQuery.lte('created_at', endDate);

        const { data: calls, count: totalCalls, error: cErr } = await callsQuery;
        if (cErr) throw new DatabaseError('Failed to fetch call logs', cErr);

        const confirmed  = bookings.filter((b: any) => b.status === 'confirmed').length;
        const cancelled  = bookings.filter((b: any) => b.status === 'cancelled').length;
        const totalGuests = bookings.reduce((s: number, b: any) => s + (b.party_size || 0), 0);
        const bySource   = bookings.reduce((acc: any, b: any) => {
            const k = b.source || 'unknown';
            acc[k] = (acc[k] || 0) + 1;
            return acc;
        }, {});

        const successfulCalls = (calls || []).filter((c: any) => c.status === 'completed').length;
        const avgDuration = calls?.length
            ? Math.round(calls.reduce((s, c: any) => s + (c.duration || 0), 0) / calls.length)
            : 0;

        res.json({
            bookings: {
                total: totalBookings ?? 0,
                confirmed,
                cancelled,
                totalGuests,
                avgPartySize: totalBookings ? (totalGuests / totalBookings).toFixed(1) : 0,
                bySource
            },
            calls: { total: totalCalls ?? 0, successful: successfulCalls, avgDuration },
            recent: {
                bookings: bookings.slice(0, 10),
                calls: (calls || []).slice(0, 10)
            }
        });
    } catch (err) { next(err); }
});

// ─── GET /dashboard/insights ──────────────────────────────────────────────────
// Calcule les 5 métriques d'analyse pour aujourd'hui.
// Déterministe — aucun ML, aucun NLP.

router.get('/insights', async (req: AuthRequest, res: Response, next) => {
    try {
        const restaurantId = req.user!.restaurantId;
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

        // 1. Récupérer capacité totale du restaurant
        const { data: restaurant, error: rErr } = await supabase
            .from('restaurants')
            .select('capacity, opening_hours')
            .eq('id', restaurantId)
            .single();

        if (rErr) throw new DatabaseError('Failed to fetch restaurant', rErr);

        const totalCapacity = restaurant?.capacity || 40;

        // 2. Réservations confirmées aujourd'hui
        const { data: todayBookings, error: bErr } = await supabase
            .from('bookings')
            .select('*')
            .eq('restaurant_id', restaurantId)
            .eq('status', 'confirmed')
            .or(`booking_date.eq.${today},booked_for.gte.${today}T00:00:00.and.booked_for.lte.${today}T23:59:59`);

        if (bErr) throw new DatabaseError('Failed to fetch today bookings', bErr);

        const confirmedReservations = (todayBookings || []).length;
        const confirmedCovers = (todayBookings || []).reduce((s: number, b: any) => s + (b.party_size || b.covers || 0), 0);

        // 3. Taux de remplissage global
        const occupancyRate = totalCapacity > 0
            ? Math.round((confirmedCovers / totalCapacity) * 100)
            : 0;

        // 4. Appels d'aujourd'hui — pour demandes non placées et abandonnées
        const { data: todayCalls, error: cErr } = await supabase
            .from('call_logs')
            .select('*')
            .eq('restaurant_id', restaurantId)
            .gte('created_at', `${today}T00:00:00`)
            .lte('created_at', `${today}T23:59:59`);

        if (cErr) throw new DatabaseError('Failed to fetch today calls', cErr);

        const calls = todayCalls || [];

        // Demandes abandonnées : durée < 15s OU status = 'missed'/'failed'
        const abandonedCalls = calls.filter((c: any) =>
            (c.duration || 0) < 15 || c.status === 'missed' || c.status === 'failed'
        ).length;

        // Demandes non placées (v1) : appel > 20s ET reservation_booked = false
        const unplacedRequests = calls.filter((c: any) =>
            (c.duration || 0) > 20 && c.reservation_booked === false
        ).length;

        // 5. Pic horaire des demandes non placées (heure avec le plus d'appels non aboutis)
        const peakBuckets: Record<number, number> = {};
        calls.filter((c: any) => c.reservation_booked === false && (c.duration || 0) > 20)
            .forEach((c: any) => {
                const h = new Date(c.created_at).getHours();
                peakBuckets[h] = (peakBuckets[h] || 0) + 1;
            });

        let peakUnplacedHour: string | null = null;
        if (Object.keys(peakBuckets).length > 0) {
            const maxHour = Object.entries(peakBuckets).sort((a, b) => b[1] - a[1])[0][0];
            peakUnplacedHour = `${maxHour}h`;
        }

        // 6. Créneau à valoriser : heure avec le moins de réservations confirmées
        // On découpe la journée en créneaux de 30min entre 12h et 23h
        const slotBuckets: Record<string, number> = {};
        const openingHours = restaurant?.opening_hours || {};
        const dayOfWeek = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][new Date().getDay()];
        const todayHours = openingHours[dayOfWeek];

        if (todayHours?.open) {
            // Build slots from opening hours
            const startH = parseInt((todayHours.from || '12:00').split(':')[0]);
            const endH   = parseInt((todayHours.to   || '23:00').split(':')[0]);
            for (let h = startH; h < endH; h++) {
                for (const m of [0, 30]) {
                    const label = `${h}h${m === 30 ? '30' : '00'}`;
                    slotBuckets[label] = 0;
                }
            }
            (todayBookings || []).forEach((b: any) => {
                const dt = b.booked_for || (b.booking_date && b.booking_time ? `${b.booking_date}T${b.booking_time}` : null);
                if (!dt) return;
                const d = new Date(dt);
                const h = d.getHours();
                const m = d.getMinutes() >= 30 ? 30 : 0;
                const label = `${h}h${m === 30 ? '30' : '00'}`;
                if (slotBuckets[label] !== undefined) slotBuckets[label]++;
            });
        }

        let bestSlotTime: string | null = null;
        const slotEntries = Object.entries(slotBuckets);
        if (slotEntries.length > 0) {
            // Slot with fewest confirmed bookings — availability to promote
            const minSlot = slotEntries.sort((a, b) => a[1] - b[1])[0];
            bestSlotTime = minSlot[0];
        }

        // 7. Créneau le plus faible (remplissage)
        let lowestSlotTime: string | null = null;
        if (slotEntries.length > 0) {
            lowestSlotTime = slotEntries.sort((a, b) => a[1] - b[1])[0][0];
        }

        logger.info({ restaurantId, today, confirmedReservations, occupancyRate }, 'Insights computed');

        res.json({
            occupancy_rate: occupancyRate,
            lowest_slot_time: lowestSlotTime,
            unplaced_requests: unplacedRequests,
            peak_unplaced_time: peakUnplacedHour,
            confirmed_reservations: confirmedReservations,
            abandoned_calls: abandonedCalls,
            best_slot_time: bestSlotTime,
        });
    } catch (err) { next(err); }
});

// ─── GET /dashboard/calls ─────────────────────────────────────────────────────

router.get('/calls', async (req: AuthRequest, res: Response, next) => {
    try {
        const restaurantId = req.user!.restaurantId;
        const limit  = Math.min(Number(req.query.limit)  || 50, 200);
        const offset = Number(req.query.offset) || 0;

        const { data: calls, error, count } = await supabase
            .from('call_logs')
            .select('*', { count: 'exact' })
            .eq('restaurant_id', restaurantId)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) throw new DatabaseError('Failed to fetch call logs', error);
        res.json({ calls, total: count, limit, offset });
    } catch (err) { next(err); }
});

export default router;
