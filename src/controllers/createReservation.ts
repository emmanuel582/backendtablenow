// ============================================
// POST /create-reservation
// Appelé après confirmation verbale de l'agent
// ============================================

import { Request, Response } from 'express';
import supabase from '../config/supabase';
import calendarService from '../services/calendar.service';
import emailService from '../services/email.service';
import logger, { logActionStart } from '../lib/logger';

// ============================================
// Verrou par restaurant (in-memory, VPS unique)
// ============================================
const restaurantLocks = new Map<string, Promise<void>>();

async function withRestaurantLock<T>(restaurantId: string, fn: () => Promise<T>): Promise<T> {
    const previous = restaurantLocks.get(restaurantId) || Promise.resolve();

    let releaseLock!: () => void;
    const current = previous.then(() => new Promise<void>((resolve) => {
        releaseLock = resolve;
    }));

    restaurantLocks.set(restaurantId, current);

    const timeout = setTimeout(() => {
        logger.warn(
            { restaurantId, action: 'lock_timeout' },
            'Restaurant lock forcibly released due to timeout'
        );
        releaseLock();
    }, 30000); // 30s timeout reduces race condition risk on slow networks

    try {
        await previous;
        return await fn();
    } finally {
        clearTimeout(timeout);
        releaseLock();
        if (restaurantLocks.get(restaurantId) === current) {
            restaurantLocks.delete(restaurantId);
        }
    }
}

// ============================================
// Google Calendar — via calendarService centralisé
// ============================================
async function createCalendarEvent(restaurantData: any, reservation: any): Promise<string | null> {
    if (!restaurantData.google_calendar_tokens) return null;

    let tokens: any;
    try {
        tokens = typeof restaurantData.google_calendar_tokens === 'string'
            ? JSON.parse(restaurantData.google_calendar_tokens)
            : restaurantData.google_calendar_tokens;
    } catch {
        return null;
    }

    if (!tokens?.access_token) return null;

    const startDate = new Date(`${reservation.date}T${reservation.time}:00`);
    const endDate = new Date(startDate.getTime() + 90 * 60 * 1000);

    const event = await calendarService.createEvent(tokens, {
        summary: `[TableNow] ${reservation.first_name} ${reservation.last_name} — ${reservation.covers} pers.`,
        description: [
            `📞 ${reservation.phone}`,
            reservation.email ? `📧 ${reservation.email}` : '',
            reservation.occasion ? `🎉 Occasion : ${reservation.occasion}` : '',
            `\nRéservation prise automatiquement via TableNow`
        ].filter(Boolean).join('\n'),
        start: startDate,
        end: endDate,
        attendees: reservation.email ? [reservation.email] : []
    });

    return event?.id || null;
}

// ============================================
// Email confirmation client (via emailService) — langue du client
// ============================================
async function sendConfirmationEmail(restaurantData: any, reservation: any): Promise<boolean> {
    if (!reservation.email) return false;

    await emailService.sendBookingConfirmation({
        to: reservation.email,
        restaurantName: restaurantData.name,
        restaurantAddress: restaurantData.address || '',
        restaurantPhone: restaurantData.phone || '',
        guestName: `${reservation.first_name} ${reservation.last_name}`.trim(),
        date: reservation.date,
        time: reservation.time,
        partySize: reservation.covers,
        confirmationNumber: reservation.booking_id || '',
        language: reservation.language === 'en' ? 'en' : 'fr'
    });
    return true;
}

// ============================================
// BCC vers le PMS du restaurant — langue du restaurant
// ============================================
async function sendBccToPMS(restaurantData: any, reservation: any): Promise<boolean> {
    if (!restaurantData.pms_email) return false;

    const restaurantLang: 'fr' | 'en' = restaurantData.language === 'en' ? 'en' : 'fr';
    const localeTag  = restaurantLang === 'en' ? 'en-GB' : 'fr-FR';
    const dateFormatted = new Date(reservation.date).toLocaleDateString(localeTag, {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });

    const labels = restaurantLang === 'en' ? {
        title:    'New booking via TableNow',
        name:     'Name',     phone: 'Phone',  email: 'Email',
        date:     'Date',     time:  'Time',   covers: 'Party size',
        occasion: 'Occasion', empty: 'not provided',
        subject:  `New booking — ${reservation.first_name} ${reservation.last_name} — ${reservation.date} ${reservation.time}`
    } : {
        title:    'Nouvelle réservation via TableNow',
        name:     'Nom',      phone: 'Téléphone', email: 'Email',
        date:     'Date',     time:  'Heure',     covers: 'Couverts',
        occasion: 'Occasion', empty: 'non renseigné',
        subject:  `Nouvelle réservation — ${reservation.first_name} ${reservation.last_name} — ${reservation.date} ${reservation.time}`
    };

    await emailService.sendRawEmail({
        to: restaurantData.pms_email,
        subject: labels.subject,
        html: `
        <p><strong>${labels.title}</strong></p>
        <ul>
            <li><strong>${labels.name} :</strong> ${reservation.first_name} ${reservation.last_name}</li>
            <li><strong>${labels.phone} :</strong> ${reservation.phone}</li>
            <li><strong>${labels.email} :</strong> ${reservation.email || labels.empty}</li>
            <li><strong>${labels.date} :</strong> ${dateFormatted}</li>
            <li><strong>${labels.time} :</strong> ${reservation.time}</li>
            <li><strong>${labels.covers} :</strong> ${reservation.covers}</li>
            ${reservation.occasion ? `<li><strong>${labels.occasion} :</strong> ${reservation.occasion}</li>` : ''}
        </ul>`
    });
    return true;
}

// ============================================
// Handler principal
// ============================================
export async function createReservation(req: Request, res: Response): Promise<void> {
    const {
        restaurant_id, first_name, last_name,
        phone, email, covers, occasion, date, time, language
    } = req.body;
    const guestLanguage: 'fr' | 'en' = language === 'en' ? 'en' : 'fr';

    const required: Record<string, any> = { restaurant_id, first_name, last_name, phone, covers, date, time };
    const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);

    if (missing.length > 0) {
        res.status(400).json({ success: false, reason: 'missing_params', missing });
        return;
    }

    const coversInt = parseInt(covers, 10);

    const result = await withRestaurantLock(restaurant_id, async () => {
        try {
            // Vérifier disponibilité via get_available_slots RPC
            const { data: slots, error: slotError } = await supabase.rpc('get_available_slots', {
                p_restaurant_id: restaurant_id,
                p_date: date,
                p_covers: coversInt
            });

            if (slotError || !slots || slots.length === 0) {
                return res.status(409).json({
                    success: false,
                    reason: 'no_longer_available',
                    agent_script: `Je suis vraiment désolé, il semblerait que ce créneau vienne juste d'être complet. Souhaitez-vous que je vous propose une autre date ?`
                });
            }

            const targetSlot = (slots as any[]).find(s => s.slot_time.slice(0, 5) === time.slice(0, 5));

            if (!targetSlot || !targetSlot.available) {
                return res.status(409).json({
                    success: false,
                    reason: 'no_longer_available',
                    remaining: targetSlot?.remaining || 0,
                    agent_script: `Je suis vraiment désolé, il semblerait que ce créneau vienne juste d'être complet. Souhaitez-vous que je vous propose une autre date ?`
                });
            }

            const { data: restaurant } = await supabase
                .from('restaurants')
                .select('name, phone, address, pms_email, google_calendar_tokens, language')
                .eq('id', restaurant_id)
                .single();

            // ── Find or create customer — keyed by (restaurant_id, phone) ──
            let customerId: string | null = null;
            {
                const { data: existing } = await supabase
                    .from('customers')
                    .select('id')
                    .eq('restaurant_id', restaurant_id)
                    .eq('phone', phone)
                    .single();
                if (existing) {
                    customerId = existing.id;
                } else {
                    const { data: created } = await supabase
                        .from('customers')
                        .insert({
                            restaurant_id,
                            phone,
                            name: `${first_name} ${last_name}`.trim(),
                            email: email || null
                        })
                        .select('id')
                        .single();
                    customerId = created?.id || null;
                }
            }

            // Internal object used by calendar/email helpers
            const reservationInfo = {
                restaurant_id,
                first_name, last_name, phone,
                email: email || null,
                covers: coversInt,
                occasion: occasion || null,
                date, time,
                language: guestLanguage,
                booking_id: '' // set after insert
            };

            // Booking insert — new schema
            const bookedFor = `${date}T${time}:00`;
            const { data: newBooking, error: insertError } = await supabase
                .from('bookings')
                .insert({
                    restaurant_id,
                    customer_id: customerId,
                    booked_for: bookedFor,
                    covers: coversInt,
                    special_requests: occasion || null,
                    source: 'phone',
                    status: 'confirmed',
                    guest_language: guestLanguage
                })
                .select()
                .single();

            if (insertError) throw insertError;

            logger.info(
                {
                    action: 'booking_created',
                    restaurant_id: newBooking.restaurant_id,
                    booking_id: newBooking.id,
                    customer_id: customerId,
                    source: 'phone',
                    covers: coversInt
                },
                'Booking successfully created'
            );
            reservationInfo.booking_id = newBooking.id;

            // Étapes non-bloquantes après libération du verrou
            let calendarEventId: string | null = null;
            try {
                calendarEventId = await createCalendarEvent(restaurant, reservationInfo);
                if (calendarEventId) {
                    await supabase.from('bookings').update({ google_calendar_event_id: calendarEventId }).eq('id', newBooking.id);
                }
            } catch (calendarErr: any) {
                logger.error(
                    {
                        action: 'calendar_sync_error',
                        booking_id: newBooking.id,
                        error: calendarErr.message
                    },
                    'Failed to sync booking to Google Calendar (non-blocking)'
                );
            }

            let emailSent = false;
            try {
                emailSent = await sendConfirmationEmail(restaurant, reservationInfo);
                await supabase.from('bookings').update({ confirmation_email_sent: emailSent }).eq('id', newBooking.id);
            } catch (emailErr: any) {
                logger.error(
                    {
                        action: 'confirmation_email_error',
                        booking_id: newBooking.id,
                        guest_email: reservationInfo.email,
                        error: emailErr.message
                    },
                    'Failed to send confirmation email (non-blocking)'
                );
            }

            let bccSent = false;
            try {
                bccSent = await sendBccToPMS(restaurant, reservationInfo);
                await supabase.from('bookings').update({ bcc_email_sent: bccSent }).eq('id', newBooking.id);
            } catch (bccErr: any) {
                logger.error(
                    {
                        action: 'bcc_email_error',
                        booking_id: newBooking.id,
                        pms_email: restaurant?.pms_email,
                        error: bccErr.message
                    },
                    'Failed to send BCC email to PMS (non-blocking)'
                );
            }

            const agentScript = guestLanguage === 'en'
                ? `Perfect ${first_name}, your booking is confirmed for ${coversInt} ${coversInt > 1 ? 'guests' : 'guest'} on ${date} at ${time}. ${email ? 'You will receive a confirmation email. ' : ''}We look forward to welcoming you. See you soon!`
                : `Parfait ${first_name}, votre réservation est confirmée pour ${coversInt} personne${coversInt > 1 ? 's' : ''} le ${date} à ${time}. ${email ? 'Vous allez recevoir un email de confirmation. ' : ''}Nous avons hâte de vous accueillir. À bientôt !`;

            return res.json({
                success: true,
                reservation_id: newBooking.id,
                calendar_event_id: calendarEventId,
                confirmation_email_sent: emailSent,
                bcc_sent: bccSent,
                agent_script: agentScript
            });

        } catch (err: any) {
            logger.error({ action: 'create_reservation', error: err.message, restaurant_id: restaurantId }, 'Critical error during reservation creation');
            const errorScript = guestLanguage === 'en'
                ? `I'm sorry, I'm experiencing a technical issue. Your booking could not be saved. Please call the restaurant directly.`
                : `Je suis désolé, je rencontre une difficulté technique. Votre réservation n'a pas pu être enregistrée. Je vous invite à rappeler directement le restaurant.`;
            return res.status(500).json({
                success: false,
                reason: 'internal_error',
                agent_script: errorScript
            });
        }
    });
}
