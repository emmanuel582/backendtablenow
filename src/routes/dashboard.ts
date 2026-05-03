import { Router, Request, Response } from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import supabase from '../config/supabase';
import { normalizeBooking } from '../services/booking.service';
import { DatabaseError } from '../lib/errors';
import logger from '../lib/logger';

const router = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayISO(): string {
    return new Date().toISOString().split('T')[0];
}

/**
 * Compute insights for a restaurant for today.
 * All deterministic — no ML, no NLP.
 */
async function computeInsights(restaurantId: string, date: string): Promise<{
    occupancy_rate: number;
    lowest_slot_time: string | null;
    unplaced_requests: number;
    peak_unplaced_time: string | null;
    confirmed_reservations: number;
    abandoned_calls: number;
    best_slot_time: string | null;
}> {
    const dateStart = `${date}T00:00:00`;
    const dateEnd   = `${date}T23:59:59`;

    // --- Fetch restaurant capacity ---
    const { data: restaurant } = await supabase
        .from('restaurants')
        .select('capacity, opening_hours')
        .eq('id', restaurantId)
        .single();

    const totalCapacity = restaurant?.capacity || 50;

    // --- Fetch today's confirmed bookings ---
    const { data: bookings } = await supabase
        .from('bookings')
        .select('party_size, booking_date, booking_time, booked_for, status')
        .eq('restaurant_id', restaurantId)
        .eq('status', 'confirmed')
        .or(`booking_date.eq.${date},booked_for.gte.${dateStart},booked_for.lte.${dateEnd}`);

    const confirmedBookings = bookings || [];
    const confirmedReservations = confirmedBookings.length;

    // --- Occupancy: covers confirmed / capacity ---
    const totalCovers = confirmedBookings.reduce((s, b) => s + (b.party_size || 0), 0);
    const occupancyRate = totalCapacity > 0 ? Math.min(totalCovers / totalCapacity, 1) : 0;

    // --- Slot occupancy (30min buckets 12h–23h) ---
    const slotBuckets: Record<string, number> = {};
    for (let h = 12; h <= 22; h++) {
        for (const m of [0, 30]) {
            const key = `${String(h).padStart(2,'0')}:${m === 0 ? '00' : '30'}`;
            slotBuckets[key] = 0;
        }
    }
    confirmedBookings.forEach(b => {
        const t = b.booking_time || (b.booked_for ? b.booked_for.split('T')[1]?.slice(0,5) : null);
        if (!t) return;
        const [hh, mm] = t.split(':').map(Number);
        const bucket = `${String(hh).padStart(2,'0')}:${mm < 30 ? '00' : '30'}`;
        if (slotBuckets[bucket] !== undefined) slotBuckets[bucket] += b.party_size || 0;
    });

    // Lowest slot = highest remaining capacity
    let lowestSlotTime: string | null = null;
    let lowestSlotCovers = Infinity;
    for (const [slot, covers] of Object.entries(slotBuckets)) {
        if (covers < lowestSlotCovers) {
            lowestSlotCovers = covers;
            lowestSlotTime = slot;
        }
    }
    const bestSlotTime = lowestSlotTime; // same: promote the least full slot

    // --- Fetch today's call logs ---
    const { data: calls } = await supabase
        .from('call_logs')
        .select('duration, status, reservation_booked, created_at, started_at')
        .eq('restaurant_id', restaurantId)
        .gte('created_at', dateStart)
        .lte('created_at', dateEnd);

    const allCalls = calls || [];

    // Abandoned: duration < 15s OR status = 'missed'
    const abandonedCalls = allCalls.filter(c =>
        (c.duration !== null && c.duration < 15) || c.status === 'missed'
    ).length;

    // Unplaced requests v1: duration > 20s AND reservation_booked = false
    const unplacedRequests = allCalls.filter(c =>
        c.reservation_booked === false && (c.duration || 0) > 20
    ).length;

    // Peak unplaced time: hour with most unplaced calls
    const unplacedByHour: Record<number, number> = {};
    allCalls
        .filter(c => c.reservation_booked === false && (c.duration || 0) > 20)
        .forEach(c => {
            const ts = c.created_at || c.started_at;
            if (!ts) return;
            const h = new Date(ts).getHours();
            unplacedByHour[h] = (unplacedByHour[h] || 0) + 1;
        });
    let peakUnplacedTime: string | null = null;
    let peakCount = 0;
    for (const [h, count] of Object.entries(unplacedByHour)) {
        if (count > peakCount) {
            peakCount = count;
            peakUnplacedTime = `${String(h).padStart(2,'0')}:00`;
        }
    }

    return {
        occupancy_rate: Math.round(occupancyRate * 100) / 100,
        lowest_slot_time: lowestSlotTime,
        unplaced_requests: unplacedRequests,
        peak_unplaced_time: peakUnplacedTime,
        confirmed_reservations: confirmedReservations,
        abandoned_calls: abandonedCalls,
        best_slot_time: bestSlotTime,
    };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

router.use(authenticateToken);

// GET /dashboard/stats
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

        const confirmed   = bookings.filter((b: any) => b.status === 'confirmed').length;
        const cancelled   = bookings.filter((b: any) => b.status === 'cancelled').length;
        const totalGuests = bookings.reduce((s: number, b: any) => s + (b.party_size || 0), 0);
        const bySource    = bookings.reduce((acc: any, b: any) => {
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
                bySource,
            },
            calls: { total: totalCalls ?? 0, successful: successfulCalls, avgDuration },
            recent: {
                bookings: bookings.slice(0, 10),
                calls: (calls || []).slice(0, 10),
            },
        });
    } catch (err) { next(err); }
});

// GET /dashboard/insights — served from cache, falls back to live compute
router.get('/insights', async (req: AuthRequest, res: Response, next) => {
    try {
        const restaurantId = req.user!.restaurantId;
        const date = (req.query.date as string) || todayISO();

        // Try cache first
        const { data: cached } = await supabase
            .from('insights_cache')
            .select('*')
            .eq('restaurant_id', restaurantId)
            .eq('date', date)
            .single();

        // Return cache if < 10 min old
        if (cached) {
            const age = Date.now() - new Date(cached.computed_at).getTime();
            if (age < 10 * 60 * 1000) {
                return res.json({
                    occupancy_rate:         cached.occupancy_rate,
                    lowest_slot_time:       cached.lowest_slot_time,
                    unplaced_requests:      cached.unplaced_requests,
                    peak_unplaced_time:     cached.peak_unplaced_time,
                    confirmed_reservations: cached.confirmed_reservations,
                    abandoned_calls:        cached.abandoned_calls,
                    best_slot_time:         cached.best_slot_time,
                    cached_at:              cached.computed_at,
                });
            }
        }

        // Compute live
        const insights = await computeInsights(restaurantId, date);

        // Upsert into cache
        await supabase.from('insights_cache').upsert({
            restaurant_id: restaurantId,
            date,
            ...insights,
            computed_at: new Date().toISOString(),
        }, { onConflict: 'restaurant_id,date' });

        res.json({ ...insights, cached_at: new Date().toISOString() });
    } catch (err) { next(err); }
});

// POST /dashboard/insights/refresh — called by pg_cron (internal)
router.post('/insights/refresh', async (req: Request, res: Response, next) => {
    try {
        const secret = req.headers['x-internal-secret'];
        if (secret !== process.env.INTERNAL_SECRET) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const date = todayISO();

        // Get all active restaurants
        const { data: restaurants, error } = await supabase
            .from('restaurants')
            .select('id')
            .eq('status', 'active');

        if (error || !restaurants) {
            return res.status(500).json({ error: 'Failed to fetch restaurants' });
        }

        let refreshed = 0;
        for (const r of restaurants) {
            try {
                const insights = await computeInsights(r.id, date);
                await supabase.from('insights_cache').upsert({
                    restaurant_id: r.id,
                    date,
                    ...insights,
                    computed_at: new Date().toISOString(),
                }, { onConflict: 'restaurant_id,date' });
                refreshed++;
            } catch (e) {
                logger.error({ restaurantId: r.id, err: e }, 'Failed to compute insights');
            }
        }

        logger.info({ refreshed, date }, '✅ Insights cache refreshed');
        res.json({ refreshed, date });
    } catch (err) { next(err); }
});

// GET /dashboard/calls
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
