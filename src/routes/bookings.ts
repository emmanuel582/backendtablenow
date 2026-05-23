import { Router, Response } from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/handlers';
import {
    ManualCreateBookingSchema,
    UpdateBookingSchema,
    BookingQuerySchema
} from '../types/schemas';
import {
    getBookings,
    getBookingById,
    cancelBooking,
    normalizeBooking,
    createBooking
} from '../services/booking.service';
import { NotFoundError, DatabaseError } from '../lib/errors';
import supabase from '../config/supabase';
import logger from '../lib/logger';

const router = Router();
router.use(authenticateToken);

// ─── GET /bookings ────────────────────────────────────────────────────────────

router.get('/', validate(BookingQuerySchema, 'query'), async (req: AuthRequest, res: Response, next) => {
    try {
        const result = await getBookings(req.user!.restaurantId, req.query as any);
        res.json(result);
    } catch (err) { next(err); }
});

// ─── GET /bookings/:id ────────────────────────────────────────────────────────

router.get('/:id', async (req: AuthRequest, res: Response, next) => {
    try {
        const booking = await getBookingById(req.params.id, req.user!.restaurantId);
        res.json({ booking });
    } catch (err) { next(err); }
});

// ─── POST /bookings (unified endpoint) ─────────────────────────────────────────
// KEEP PUBLIC CONTRACT: Handles all booking creation (manual, VAPI, web, etc.)
// Single endpoint for all sources

router.post('/', validate(ManualCreateBookingSchema), async (req: AuthRequest, res: Response, next) => {
    try {
        const { guestName, guestEmail, guestPhone, date, time, partySize, specialRequests, language } = req.body;
        const restaurantId = req.user!.restaurantId;
        const log = logger.child({ restaurantId, path: 'POST /bookings' });

        const { data: restaurant } = await supabase
            .from('restaurants')
            .select('*')
            .eq('id', restaurantId)
            .single();

        if (!restaurant) throw new NotFoundError('Restaurant');

        const guestLanguage: 'fr' | 'en' = language === 'en' || language === 'fr'
            ? language
            : (restaurant.language === 'en' ? 'en' : 'fr');

        const booking = await createBooking(
            {
                restaurant_id: restaurantId,
                date,
                time,
                covers: partySize,
                guest_name: guestName,
                guest_email: guestEmail,
                guest_phone: guestPhone,
                special_requests: specialRequests,
                source: 'manual',
                guest_language: guestLanguage
            },
            undefined,
            restaurant
        );

        log.info({ bookingId: booking.id, language: guestLanguage }, 'Manual booking created');
        res.status(201).json({ message: 'Booking created', booking: normalizeBooking(booking) });
    } catch (err) { next(err); }
});

// ─── PUT /bookings/:id ────────────────────────────────────────────────────────

router.put('/:id', validate(UpdateBookingSchema), async (req: AuthRequest, res: Response, next) => {
    try {
        const { id } = req.params;
        const restaurantId = req.user!.restaurantId;

        await getBookingById(id, restaurantId); // Ensures exists + belongs to restaurant

        const { data: booking, error } = await supabase
            .from('bookings')
            .update(req.body)
            .eq('id', id)
            .eq('restaurant_id', restaurantId)
            .select()
            .single();

        if (error) throw new DatabaseError('Failed to update booking', error);
        res.json({ message: 'Booking updated', booking: normalizeBooking(booking) });
    } catch (err) { next(err); }
});

// ─── DELETE /bookings/:id ─────────────────────────────────────────────────────

router.delete('/:id', async (req: AuthRequest, res: Response, next) => {
    try {
        const booking = await cancelBooking(req.params.id, req.user!.restaurantId);
        res.json({ message: 'Booking cancelled', booking });
    } catch (err) { next(err); }
});

export default router;
