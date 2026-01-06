import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import supabase from '../config/supabase';
import emailService from '../services/email.service';
import hubspotService from '../services/hubspot.service';
import calendarService from '../services/calendar.service';

const router = Router();

// All routes require authentication
router.use(authenticateToken);

/**
 * Create new booking
 */
router.post('/', async (req: AuthRequest, res: Response) => {
    try {
        const {
            guestName,
            guestEmail,
            guestPhone,
            date,
            time,
            partySize,
            specialRequests
        } = req.body;

        const restaurantId = req.user!.restaurantId;

        // Validation
        if (!guestName || !guestEmail || !date || !time || !partySize) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Check availability
        const isAvailable = await checkTableAvailability(restaurantId, date, time, partySize);
        if (!isAvailable) {
            return res.status(409).json({ error: 'No tables available for the requested time' });
        }

        // Generate confirmation number
        const confirmationNumber = `TN-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;

        // Create booking
        const { data: booking, error: dbError } = await supabase
            .from('bookings')
            .insert({
                restaurant_id: restaurantId,
                guest_name: guestName,
                guest_email: guestEmail,
                guest_phone: guestPhone,
                booking_date: date,
                booking_time: time,
                party_size: partySize,
                special_requests: specialRequests,
                confirmation_number: confirmationNumber,
                status: 'confirmed',
                source: 'manual'
            })
            .select()
            .single();

        if (dbError) {
            console.error('Database error:', dbError);
            return res.status(500).json({ error: 'Failed to create booking' });
        }

        // Get restaurant details
        const { data: restaurant } = await supabase
            .from('restaurants')
            .select('*')
            .eq('id', restaurantId)
            .single();

        // Send confirmation email to guest
        await emailService.sendBookingConfirmation({
            to: guestEmail,
            restaurantName: restaurant?.name || 'Restaurant',
            guestName,
            date,
            time,
            partySize,
            confirmationNumber
        });

        // Send notification to restaurant
        await emailService.sendRestaurantNotification({
            to: restaurant?.email || '',
            subject: 'New Booking Received',
            message: `New booking for ${partySize} guests on ${date} at ${time}`,
            bookingDetails: booking
        });

        // Create HubSpot contact and deal
        try {
            await hubspotService.upsertContact({
                email: guestEmail,
                firstName: guestName.split(' ')[0],
                lastName: guestName.split(' ').slice(1).join(' '),
                phone: guestPhone,
                restaurantName: restaurant?.name
            });

            const deal = await hubspotService.createDeal({
                dealName: `${restaurant?.name} - ${guestName} - ${date}`,
                contactEmail: guestEmail,
                restaurantId,
                reservationDate: `${date} ${time}`,
                partySize
            });

            // Update booking with HubSpot deal ID
            await supabase
                .from('bookings')
                .update({ hubspot_deal_id: deal.id })
                .eq('id', booking.id);
        } catch (hubspotError) {
            console.error('HubSpot error:', hubspotError);
            // Don't fail the booking if HubSpot fails
        }

        // Create calendar event if restaurant has calendar connected
        if (restaurant?.google_calendar_tokens) {
            try {
                const startDateTime = new Date(`${date}T${time}`);
                const endDateTime = new Date(startDateTime.getTime() + 2 * 60 * 60 * 1000); // 2 hours

                const calendarEvent = await calendarService.createEvent(
                    JSON.parse(restaurant.google_calendar_tokens),
                    {
                        summary: `Booking: ${guestName} (${partySize} guests)`,
                        description: `Confirmation: ${confirmationNumber}\nPhone: ${guestPhone}\nEmail: ${guestEmail}\nSpecial Requests: ${specialRequests || 'None'}`,
                        start: startDateTime,
                        end: endDateTime,
                        attendees: [guestEmail]
                    }
                );

                // Update booking with calendar event ID
                await supabase
                    .from('bookings')
                    .update({ calendar_event_id: calendarEvent.id })
                    .eq('id', booking.id);
            } catch (calendarError) {
                console.error('Calendar error:', calendarError);
            }
        }

        res.status(201).json({
            message: 'Booking created successfully',
            booking,
            confirmationNumber
        });
    } catch (error: any) {
        console.error('Create booking error:', error);
        res.status(500).json({ error: 'Failed to create booking' });
    }
});

/**
 * Get all bookings for restaurant
 */
router.get('/', async (req: AuthRequest, res: Response) => {
    try {
        const restaurantId = req.user!.restaurantId;
        const { status, date, limit = 50, offset = 0 } = req.query;

        let query = supabase
            .from('bookings')
            .select('*', { count: 'exact' })
            .eq('restaurant_id', restaurantId)
            .order('booking_date', { ascending: false })
            .order('booking_time', { ascending: false })
            .range(Number(offset), Number(offset) + Number(limit) - 1);

        if (status) {
            query = query.eq('status', status);
        }

        if (date) {
            query = query.eq('booking_date', date);
        }

        const { data: bookings, error, count } = await query;

        if (error) {
            console.error('Database error:', error);
            return res.status(500).json({ error: 'Failed to fetch bookings' });
        }

        res.json({
            bookings,
            total: count,
            limit: Number(limit),
            offset: Number(offset)
        });
    } catch (error: any) {
        console.error('Get bookings error:', error);
        res.status(500).json({ error: 'Failed to fetch bookings' });
    }
});

/**
 * Get single booking
 */
router.get('/:id', async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const restaurantId = req.user!.restaurantId;

        const { data: booking, error } = await supabase
            .from('bookings')
            .select('*')
            .eq('id', id)
            .eq('restaurant_id', restaurantId)
            .single();

        if (error || !booking) {
            return res.status(404).json({ error: 'Booking not found' });
        }

        res.json({ booking });
    } catch (error: any) {
        console.error('Get booking error:', error);
        res.status(500).json({ error: 'Failed to fetch booking' });
    }
});

/**
 * Update booking
 */
router.put('/:id', async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const restaurantId = req.user!.restaurantId;
        const updates = req.body;

        // Get existing booking
        const { data: existingBooking } = await supabase
            .from('bookings')
            .select('*')
            .eq('id', id)
            .eq('restaurant_id', restaurantId)
            .single();

        if (!existingBooking) {
            return res.status(404).json({ error: 'Booking not found' });
        }

        // Update booking
        const { data: booking, error } = await supabase
            .from('bookings')
            .update(updates)
            .eq('id', id)
            .eq('restaurant_id', restaurantId)
            .select()
            .single();

        if (error) {
            console.error('Database error:', error);
            return res.status(500).json({ error: 'Failed to update booking' });
        }

        // Update calendar event if exists
        if (existingBooking.calendar_event_id) {
            const { data: restaurant } = await supabase
                .from('restaurants')
                .select('google_calendar_tokens')
                .eq('id', restaurantId)
                .single();

            if (restaurant?.google_calendar_tokens) {
                try {
                    await calendarService.updateEvent(
                        JSON.parse(restaurant.google_calendar_tokens),
                        existingBooking.calendar_event_id,
                        {
                            summary: `Booking: ${booking.guest_name} (${booking.party_size} guests)`,
                            start: new Date(`${booking.booking_date}T${booking.booking_time}`),
                            end: new Date(new Date(`${booking.booking_date}T${booking.booking_time}`).getTime() + 2 * 60 * 60 * 1000)
                        }
                    );
                } catch (calendarError) {
                    console.error('Calendar update error:', calendarError);
                }
            }
        }

        res.json({ message: 'Booking updated successfully', booking });
    } catch (error: any) {
        console.error('Update booking error:', error);
        res.status(500).json({ error: 'Failed to update booking' });
    }
});

/**
 * Cancel booking
 */
router.delete('/:id', async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const restaurantId = req.user!.restaurantId;

        // Get booking
        const { data: booking } = await supabase
            .from('bookings')
            .select('*')
            .eq('id', id)
            .eq('restaurant_id', restaurantId)
            .single();

        if (!booking) {
            return res.status(404).json({ error: 'Booking not found' });
        }

        // Update status to cancelled
        const { error } = await supabase
            .from('bookings')
            .update({ status: 'cancelled' })
            .eq('id', id);

        if (error) {
            console.error('Database error:', error);
            return res.status(500).json({ error: 'Failed to cancel booking' });
        }

        // Delete calendar event
        if (booking.calendar_event_id) {
            const { data: restaurant } = await supabase
                .from('restaurants')
                .select('google_calendar_tokens')
                .eq('id', restaurantId)
                .single();

            if (restaurant?.google_calendar_tokens) {
                try {
                    await calendarService.deleteEvent(
                        JSON.parse(restaurant.google_calendar_tokens),
                        booking.calendar_event_id
                    );
                } catch (calendarError) {
                    console.error('Calendar delete error:', calendarError);
                }
            }
        }

        // Update HubSpot deal
        if (booking.hubspot_deal_id) {
            try {
                await hubspotService.updateDealStatus(booking.hubspot_deal_id, 'cancelled');
            } catch (hubspotError) {
                console.error('HubSpot error:', hubspotError);
            }
        }

        res.json({ message: 'Booking cancelled successfully' });
    } catch (error: any) {
        console.error('Cancel booking error:', error);
        res.status(500).json({ error: 'Failed to cancel booking' });
    }
});

/**
 * Check table availability
 */
async function checkTableAvailability(
    restaurantId: string,
    date: string,
    time: string,
    partySize: number
): Promise<boolean> {
    // Get restaurant capacity and existing bookings
    const { data: restaurant } = await supabase
        .from('restaurants')
        .select('capacity, max_party_size')
        .eq('id', restaurantId)
        .single();

    if (!restaurant) return false;

    // Check if party size exceeds maximum
    if (partySize > (restaurant.max_party_size || 10)) {
        return false;
    }

    // Get bookings for the same date and time slot (±1 hour)
    const { data: existingBookings } = await supabase
        .from('bookings')
        .select('party_size')
        .eq('restaurant_id', restaurantId)
        .eq('booking_date', date)
        .gte('booking_time', time)
        .lte('booking_time', time)
        .eq('status', 'confirmed');

    const totalBooked = existingBookings?.reduce((sum, b) => sum + b.party_size, 0) || 0;
    const availableCapacity = (restaurant.capacity || 50) - totalBooked;

    return availableCapacity >= partySize;
}

export default router;
