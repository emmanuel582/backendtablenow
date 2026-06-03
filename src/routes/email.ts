import { Router, Request, Response } from 'express';
import { authenticateToken, AuthRequest, validateBCCSecret } from '../middleware/auth';
import supabase from '../config/supabase';
import emailService from '../services/email.service';
import { createBooking } from '../services/booking.service';
import calendarSync from '../services/calendarSync.service';
import logger from '../lib/logger';

const router = Router();

/**
 * BCC email webhook (receives emails from Zenchef/SevenRooms)
 * SECURITY: Requires X-BCC-Secret header matching BCC_SECRET env var
 * Prevents attackers from faking PMS notifications
 */
router.post('/bcc', validateBCCSecret, async (req: Request, res: Response) => {
    try {
        // CloudMailin sends data in specific format
        const { envelope, plain, html, headers } = req.body;

        // Extract email details from CloudMailin format
        const to = envelope?.to || headers?.to || req.body.to;
        const from = envelope?.from || headers?.from || req.body.from;
        const subject = headers?.subject || req.body.subject || '';
        const emailBody = plain || html || req.body.text || req.body.html || '';
        const raw = req.body.raw || emailBody;

        logger.info({ subject }, 'BCC email received');

        // Extract restaurant ID from BCC email
        // Format: bcc+r-{restaurant_id}@tablenow.io
        const match = to.match(/r-([a-f0-9-]+)@/);
        if (!match) {
            logger.error('Invalid BCC email format');
            return res.status(400).json({ error: 'Invalid BCC email format' });
        }

        const restaurantId = match[1];
        logger.info({ restaurantId }, 'Processing BCC email for restaurant');

        // Parse email content
        const parsedData = await emailService.parseBCCEmail(raw || emailBody);

        // Store in database
        await supabase.from('bcc_emails').insert({
            restaurant_id: restaurantId,
            from_email: from,
            subject,
            parsed_type: parsedData.type,
            parsed_source: parsedData.source,
            guest_email: parsedData.email,
            guest_phone: parsedData.phone,
            booking_date: parsedData.date,
            booking_time: parsedData.time,
            party_size: parsedData.partySize,
            raw_content: raw || emailBody
        });

        // Fetch restaurant for integrations
        const { data: restaurant } = await supabase
            .from('restaurants')
            .select('name')
            .eq('id', restaurantId)
            .single() as any;

        const hubspotService = require('../services/hubspot.service').default;

        // Helper to sync HubSpot deal stage
        const syncHubspotStage = async (dealId: string | null, stage: 'confirmed' | 'cancelled') => {
            if (!dealId) return;
            try {
                await hubspotService.updateDealStatus(dealId, stage);
            } catch (err) {
                logger.error({ err }, 'HubSpot stage sync error for BCC');
            }
        };

        // If it's a new booking, create it in our system
        if (parsedData.type === 'new' && parsedData.email && parsedData.date && parsedData.time) {
            const booking = await createBooking(
                {
                    restaurant_id: restaurantId,
                    date: parsedData.date,
                    time: parsedData.time,
                    covers: parsedData.partySize || 1,
                    guest_name: parsedData.guestName || 'Guest',
                    guest_email: parsedData.email,
                    guest_phone: parsedData.phone || null,
                    source: 'web'
                },
                `bcc-email-${restaurantId}`,
                {
                    id: restaurantId,
                    name: restaurant?.name || 'Restaurant'
                }
            );

            // 1. HubSpot Sync
            try {
                await hubspotService.upsertContact({
                    email: parsedData.email,
                    firstName: parsedData.guestName?.split(' ')[0] || 'Guest',
                    lastName: parsedData.guestName?.split(' ').slice(1).join(' ') || '',
                    phone: parsedData.phone,
                    restaurantName: restaurant?.name
                });

                const deal = await hubspotService.createDeal({
                    dealName: `${restaurant?.name} - ${parsedData.guestName} - ${parsedData.date}`,
                    contactEmail: parsedData.email,
                    restaurantId,
                    reservationDate: `${parsedData.date} ${parsedData.time}`,
                    partySize: parsedData.partySize
                });

                // Persist deal id
                if (deal?.id) {
                    await supabase
                        .from('bookings')
                        .update({ hubspot_deal_id: deal.id })
                        .eq('id', booking.id);
                }
            } catch (err) {
                logger.error({ err }, 'HubSpot sync error for BCC');
            }

            // 2. Calendar sync — handled by createBooking side effects (onBookingCreated),
            //    which fans out to every connected calendar.
        }

        // Handle modifications
        if (parsedData.type === 'modification' && parsedData.email) {
            // Find booking by confirmation or email/date
            let modQuery = supabase
                .from('bookings')
                .select('*')
                .eq('restaurant_id', restaurantId)
                .order('created_at', { ascending: false })
                .limit(1);

            if (parsedData.confirmationNumber) {
                modQuery = modQuery.eq('confirmation_number', parsedData.confirmationNumber);
            } else {
                modQuery = modQuery.eq('guest_email', parsedData.email);
            }

            const { data: booking } = await modQuery.single();

            if (booking) {
                const updates: any = {
                    booking_date: parsedData.date || booking.booking_date,
                    booking_time: parsedData.time || booking.booking_time,
                    party_size: parsedData.partySize || booking.party_size
                };

                await supabase
                    .from('bookings')
                    .update(updates)
                    .eq('id', booking.id);

                void calendarSync.onBookingUpdated(booking.id);

                await syncHubspotStage(booking.hubspot_deal_id, 'confirmed');
            }
        }

        // Handle cancellations
        if (parsedData.type === 'cancellation' && parsedData.email) {
            let cancelQuery = supabase
                .from('bookings')
                .select('*')
                .eq('restaurant_id', restaurantId)
                .order('created_at', { ascending: false })
                .limit(1);

            if (parsedData.confirmationNumber) {
                cancelQuery = cancelQuery.eq('confirmation_number', parsedData.confirmationNumber);
            } else {
                cancelQuery = cancelQuery.eq('guest_email', parsedData.email);
            }

            const { data: booking } = await cancelQuery.single();

            if (booking) {
                await supabase
                    .from('bookings')
                    .update({ status: 'cancelled' })
                    .eq('id', booking.id);

                void calendarSync.onBookingCancelled(booking.id);

                await syncHubspotStage(booking.hubspot_deal_id, 'cancelled');
            }
        }

        res.json({ received: true, parsed: parsedData });
    } catch (error: any) {
        logger.error({ err: error }, 'BCC email processing error');
        res.status(500).json({ error: 'Failed to process email' });
    }
});

/**
 * Get BCC email logs
 */
router.get('/bcc', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const restaurantId = req.user!.restaurantId;
        const { limit = 50, offset = 0 } = req.query;

        const { data: emails, error, count } = await supabase
            .from('bcc_emails')
            .select('*', { count: 'exact' })
            .eq('restaurant_id', restaurantId)
            .order('created_at', { ascending: false })
            .range(Number(offset), Number(offset) + Number(limit) - 1);

        if (error) {
            return res.status(500).json({ error: 'Failed to fetch emails' });
        }

        res.json({ emails, total: count, limit: Number(limit), offset: Number(offset) });
    } catch (error: any) {
        logger.error({ err: error }, 'Get BCC emails error');
        res.status(500).json({ error: 'Failed to fetch emails' });
    }
});

export default router;
