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
    createBookingCore
} from '../services/booking.service';
import { NotFoundError, DatabaseError } from '../lib/errors';
import supabase from '../config/supabase';
import emailService from '../services/email.service';
import calendarService from '../services/calendar.service';
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

// ─── POST /bookings (manual creation from dashboard) ─────────────────────────

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

        // Manual booking : si la langue n'est pas fournie par le formulaire,
        // on retombe sur celle du restaurant.
        const guestLanguage: 'fr' | 'en' = language === 'en' || language === 'fr'
            ? language
            : (restaurant.language === 'en' ? 'en' : 'fr');

        const booking = await createBookingCore({
            restaurantId,
            date,
            time,
            phone: guestPhone || '',
            guestName,
            guestEmail,
            partySize,
            source: 'dashboard',
            specialRequests,
            correlationId: req.headers['x-correlation-id'] as string | undefined
        });

        log.info({ bookingId: booking.id, language: guestLanguage }, 'Manual booking created');

        // Non-blocking side effects
        setImmediate(async () => {
            try {
                await emailService.sendBookingConfirmation({
                    to: guestEmail, restaurantName: restaurant.name,
                    restaurantAddress: restaurant.address || '',
                    restaurantPhone: restaurant.phone || '',
                    guestName, date, time, partySize, confirmationNumber: booking.id,
                    language: guestLanguage
                });
            } catch (e) { log.warn({ err: e }, 'Guest confirmation email failed'); }

            if (restaurant.confirmation_email) {
                try {
                    await emailService.sendRestaurantNotification({
                        to: restaurant.confirmation_email,
                        subject: `Nouvelle réservation — ${guestName}`,
                        message: `Une réservation manuelle vient d'être enregistrée depuis le dashboard.`,
                        bookingDetails: {
                            guest_name: guestName, guest_phone: guestPhone || null, guest_email: guestEmail,
                            booking_date: date, booking_time: time, party_size: partySize,
                            confirmation_number: booking.id, source: 'manual'
                        }
                    });
                } catch (e) { log.warn({ err: e }, 'Restaurant notification failed'); }
            }

            if (restaurant.google_calendar_tokens) {
                try {
                    const tokens = JSON.parse(restaurant.google_calendar_tokens);
                    const start = new Date(`${date}T${time}`);
                    const end = new Date(start.getTime() + 2 * 3600000);
                    await calendarService.createEvent(tokens, {
                        summary: `${guestName} (${partySize} pers.)`,
                        description: `Tel: ${guestPhone} | Email: ${guestEmail}`,
                        start, end, attendees: [guestEmail]
                    });
                } catch (e) { log.warn({ err: e }, 'Calendar event failed'); }
            }
        });

        res.status(201).json({ message: 'Booking created', booking });
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
