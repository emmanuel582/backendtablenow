import { Router, Request, Response } from 'express';
import supabase from '../config/supabase';
import emailService from '../services/email.service';
import vapiService from '../services/vapi.service';

import calendarService from '../services/calendar.service';

const router = Router();

/**
 * Resolve restaurant_id: accepts UUID or slug, returns UUID or null
 */
async function resolveRestaurantId(idOrSlug: string): Promise<string | null> {
    // UUID pattern check
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);

    if (isUuid) {
        const { data } = await supabase.from('restaurants').select('id').eq('id', idOrSlug).single();
        return data?.id || null;
    }

    // Try slug lookup
    const { data } = await supabase.from('restaurants').select('id').eq('slug', idOrSlug).single();
    return data?.id || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// VAPI webhook handler for call events
// ─────────────────────────────────────────────────────────────────────────────
router.post('/webhook', async (req: Request, res: Response) => {
    try {
        const event = req.body.message || req.body;
        console.log('VAPI Webhook received:', JSON.stringify(event, null, 2));

        switch (event.type) {
            case 'call.started':
                await handleCallStarted(event);
                break;
            case 'call.ended':
                await handleCallEnded(event);
                break;
            case 'tool-calls':
                return await handleToolCalls(event, res);
            case 'function-call':
                return await handleFunctionCall(event, res);
            case 'assistant-request':
                return await handleAssistantRequest(event, res);
            case 'end-of-call-report':
                console.log('Processing end-of-call-report event:', JSON.stringify(event, null, 2));
                await handleCallEnded(event);
                break;
            default:
                console.log('Unhandled event type:', event.type);
        }

        res.json({ received: true });
    } catch (error: any) {
        console.error('VAPI webhook error:', error);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /assistant-config — Dynamic variable injection per call
// VAPI calls this on each incoming call to fill {{variable}} placeholders
// ─────────────────────────────────────────────────────────────────────────────
router.post('/assistant-config', async (req: Request, res: Response) => {
    try {
        const phoneNumber = req.body?.message?.call?.to;

        console.log('📞 assistant-config request for phone:', phoneNumber);

        if (!phoneNumber) {
            return res.status(400).json({ error: 'No phone number in request' });
        }

        const { data: restaurant } = await supabase
            .from('restaurants')
            .select('id, name, address, phone, opening_hours')
            .eq('vapi_phone_number', phoneNumber)
            .single();

        if (!restaurant) {
            console.error('❌ Restaurant not found for phone:', phoneNumber);
            return res.status(404).json({ error: 'Restaurant not found' });
        }

        const openingHoursFormatted = vapiService.formatOpeningHours(restaurant.opening_hours);

        // Live date injection (Paris timezone)
        const now = new Date();
        const tz = 'Europe/Paris';
        const fmtFull = new Intl.DateTimeFormat('fr-FR', { timeZone: tz, weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
        const currentDate = fmtFull.format(now);
        const todayParts = new Intl.DateTimeFormat('fr-FR', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
            .formatToParts(now).reduce((a: any, p) => { a[p.type] = p.value; return a; }, {} as any);
        const currentDateISO = todayParts['year'] + '-' + todayParts['month'] + '-' + todayParts['day'];
        const isoFmt = new Intl.DateTimeFormat('fr-FR', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
        const dayFmtEN = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' });
        const isoOf = (d: Date) => {
            const p = isoFmt.formatToParts(d).reduce((a: any, x) => { a[x.type] = x.value; return a; }, {} as any);
            return p['year'] + '-' + p['month'] + '-' + p['day'];
        };
        const seen: Record<string, number> = {};
        const parts = [
            'tomorrow=' + isoOf(new Date(now.getTime() + 86400000)),
            'day_after_tomorrow=' + isoOf(new Date(now.getTime() + 172800000))
        ];
        for (let i = 1; i <= 14; i++) {
            const d = new Date(now.getTime() + i * 86400000);
            const dayEN = dayFmtEN.format(d).toLowerCase();
            const iso = isoOf(d);
            seen[dayEN] = (seen[dayEN] || 0) + 1;
            const key = seen[dayEN] === 1 ? dayEN : 'next_' + dayEN;
            parts.push(key + '=' + iso);
        }
        const nextDays = parts.join(', ');

        console.log('assistant-config: ' + restaurant.name + ' today=' + currentDateISO);

        res.json({
            assistant: {
                variableValues: {
                    restaurantName: restaurant.name,
                    address: restaurant.address || '',
                    humanPhone: restaurant.phone || '',
                    openingHours: openingHoursFormatted,
                    restaurantId: restaurant.id,
                    currentDate,
                    currentDateISO,
                    nextDays
                }
            }
        });
    } catch (error: any) {
        console.error('❌ assistant-config error:', error);
        res.status(500).json({ error: 'Failed to build assistant config' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /check-availability — VAPI tool endpoint
// Accepts both direct flat body AND VAPI tool-call wrapper format
// ─────────────────────────────────────────────────────────────────────────────
router.post('/check-availability', async (req: Request, res: Response) => {
    try {
        // Extract params: flat body OR VAPI tool-call wrapper
        const { message } = req.body;
        const toolCall = message?.toolCallList?.[0] || message?.toolCalls?.[0];
        let restaurantId: string, date: string, time: string, covers: number;

        if (toolCall) {
            const rawArgs = toolCall.function?.arguments || toolCall.parameters || '{}';
            const params = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
            restaurantId = params.restaurant_id;
            date = params.date;
            time = params.time;
            covers = parseInt(params.covers || params.partySize, 10);
        } else {
            restaurantId = req.body.restaurant_id;
            date = req.body.date;
            time = req.body.time;
            covers = parseInt(req.body.covers, 10);
        }

        if (!restaurantId || !date || !time || !covers) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Resolve slug to UUID if needed
        const resolvedId = await resolveRestaurantId(restaurantId);
        if (!resolvedId) {
            const payload = { available: false, message: 'Restaurant non trouvé.' };
            return toolCall
                ? res.json({ results: [{ toolCallId: toolCall.id, result: JSON.stringify(payload) }] })
                : res.status(404).json(payload);
        }

        console.log(`🔍 check-availability: ${resolvedId} — ${date} ${time} x${covers}`);

        // Check closed dates
        const { data: closed } = await supabase
            .from('closed_dates')
            .select('reason')
            .eq('restaurant_id', resolvedId)
            .eq('closed_on', date)
            .maybeSingle();

        if (closed) {
            const payload = {
                available: false,
                message: `Le restaurant est fermé le ${date}. ${closed.reason || 'Souhaitez-vous essayer une autre date ?'}`
            };
            return toolCall
                ? res.json({ results: [{ toolCallId: toolCall.id, result: JSON.stringify(payload) }] })
                : res.json(payload);
        }

        // Get available slots via RPC
        const { data: slots, error } = await supabase.rpc('get_available_slots', {
            p_restaurant_id: resolvedId,
            p_date: date,
            p_covers: covers
        });

        if (error) {
            console.error('❌ get_available_slots error:', error);
            const payload = { available: false, message: 'Impossible de vérifier la disponibilité.' };
            return toolCall
                ? res.json({ results: [{ toolCallId: toolCall.id, result: JSON.stringify(payload) }] })
                : res.status(500).json(payload);
        }

        const slotMatch = (slots as any[] || []).find(s => s.slot_time?.slice(0, 5) === time);

        if (!slotMatch || !slotMatch.available) {
            // Find 2 alternative slots (same day, available)
            const alternatives = (slots as any[] || [])
                .filter(s => s.available)
                .map(s => s.slot_time?.slice(0, 5))
                .filter(Boolean)
                .slice(0, 2);

            const payload = {
                available: false,
                message: slotMatch
                    ? `Le créneau de ${time} est complet pour ${covers} personne${covers > 1 ? 's' : ''}.`
                    : `Pas de disponibilité à ${time} le ${date}.`,
                alternatives
            };
            return toolCall
                ? res.json({ results: [{ toolCallId: toolCall.id, result: JSON.stringify(payload) }] })
                : res.json(payload);
        }

        console.log(`✅ Available at ${time} — ${slotMatch.remaining} remaining`);
        const payload = {
            available: true,
            message: `Le créneau du ${date} à ${time} pour ${covers} personne${covers > 1 ? 's' : ''} est disponible.`
        };
        return toolCall
            ? res.json({ results: [{ toolCallId: toolCall.id, result: JSON.stringify(payload) }] })
            : res.json(payload);
    } catch (error: any) {
        console.error('❌ check-availability error:', error);
        res.status(500).json({ error: 'Availability check failed' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /create-booking — VAPI tool endpoint
// Accepts both direct flat body AND VAPI tool-call wrapper format
// ─────────────────────────────────────────────────────────────────────────────
router.post('/create-booking', async (req: Request, res: Response) => {
    try {
        // Extract params: flat body OR VAPI tool-call wrapper
        const { message } = req.body;
        const toolCall = message?.toolCallList?.[0] || message?.toolCalls?.[0];
        const callerPhone = message?.call?.customer?.number;
        let restaurantId: string, date: string, time: string, covers: number;
        let firstName: string, lastName: string, guestPhone: string, guestEmail: string;
        let language: 'fr' | 'en';

        if (toolCall) {
            const rawArgs = toolCall.function?.arguments || toolCall.parameters || '{}';
            const params = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
            restaurantId = params.restaurant_id;
            date = params.date;
            time = params.time;
            covers = parseInt(params.covers || params.partySize, 10);
            firstName = params.first_name || '';
            lastName = params.last_name || '';
            guestPhone = params.phone || params.guestPhone || callerPhone || '';
            guestEmail = params.email || params.guestEmail || '';
            language = params.language === 'en' ? 'en' : 'fr';
        } else {
            restaurantId = req.body.restaurant_id;
            date = req.body.date;
            time = req.body.time;
            covers = parseInt(req.body.covers, 10);
            firstName = req.body.first_name || '';
            lastName = req.body.last_name || '';
            guestPhone = req.body.phone || '';
            guestEmail = req.body.email || '';
            language = req.body.language === 'en' ? 'en' : 'fr';
        }

        if (!restaurantId || !date || !time || !covers || !firstName || !lastName || !guestPhone) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const guestName = `${firstName} ${lastName}`.trim();

        // Resolve slug to UUID if needed
        const resolvedId = await resolveRestaurantId(restaurantId);
        if (!resolvedId) {
            const payload = { success: false, message: 'Restaurant non trouvé.' };
            return toolCall
                ? res.json({ results: [{ toolCallId: toolCall.id, result: JSON.stringify(payload) }] })
                : res.status(404).json(payload);
        }

        console.log(`📝 create-booking: ${resolvedId} — ${guestName} ${date} ${time} x${covers}`);

        const { data: restaurant } = await supabase
            .from('restaurants')
            .select('*')
            .eq('id', resolvedId)
            .single();

        if (!restaurant) {
            const payload = { success: false, message: 'Restaurant non trouvé.' };
            return toolCall
                ? res.json({ results: [{ toolCallId: toolCall.id, result: JSON.stringify(payload) }] })
                : res.status(404).json(payload);
        }

        // Find or create customer
        let customerId: string | null = null;
        if (guestPhone) {
            const { data: existing } = await supabase
                .from('customers')
                .select('id')
                .eq('restaurant_id', resolvedId)
                .eq('phone', guestPhone)
                .single();
            if (existing) {
                customerId = existing.id;
            } else {
                const { data: created } = await supabase
                    .from('customers')
                    .insert({ restaurant_id: resolvedId, phone: guestPhone, name: guestName, email: guestEmail || null })
                    .select('id')
                    .single();
                customerId = created?.id || null;
            }
        }

        // Normalize time
        const normalizedTime = normalizeTime(time) || time;
        const bookedFor = `${date}T${normalizedTime}:00`;

        const { data: booking, error: insertError } = await supabase
            .from('bookings')
            .insert({
                restaurant_id: resolvedId,
                customer_id: customerId,
                booked_for: bookedFor,
                covers,
                source: 'phone',
                status: 'confirmed',
                call_id: null,
                guest_language: language
            })
            .select()
            .single();

        if (insertError || !booking) {
            console.error('[create-booking] Insert error:', insertError);
            const payload = { success: false, message: 'Erreur lors de la création de la réservation.' };
            return toolCall
                ? res.json({ results: [{ toolCallId: toolCall.id, result: JSON.stringify(payload) }] })
                : res.status(500).json(payload);
        }

        console.log(`✅ Booking created: ${booking.id}`);

        // Non-blocking: Google Calendar
        if (restaurant.google_calendar_tokens) {
            setImmediate(async () => {
                try {
                    const tokens = JSON.parse(restaurant.google_calendar_tokens);
                    const startTime = new Date(`${date}T${normalizedTime}:00`);
                    const endTime = new Date(startTime.getTime() + 90 * 60000);
                    const gCalEvent = await calendarService.createEvent(tokens, {
                        summary: `[TableNow] ${guestName} — ${covers} pers.`,
                        description: `📞 ${guestPhone}\n${guestEmail ? '📧 ' + guestEmail : ''}`,
                        start: startTime, end: endTime,
                        attendees: guestEmail ? [guestEmail] : []
                    });
                    if (gCalEvent?.id) await supabase.from('bookings').update({ google_calendar_event_id: gCalEvent.id }).eq('id', booking.id);
                } catch (err: any) { console.error('[create-booking] Calendar:', err.message); }
            });
        }

        // Non-blocking: Confirmation email (in caller's language)
        if (guestEmail) {
            setImmediate(async () => {
                try {
                    await emailService.sendBookingConfirmation({
                        to: guestEmail, restaurantName: restaurant.name,
                        restaurantAddress: restaurant.address || '',
                        restaurantPhone: restaurant.phone || '',
                        guestName,
                        date, time: normalizedTime, partySize: covers, confirmationNumber: booking.id,
                        language
                    });
                    await supabase.from('bookings').update({ confirmation_email_sent: true }).eq('id', booking.id);
                } catch (err: any) { console.error('[create-booking] Guest email:', err.message); }
            });
        }

        // Non-blocking: Restaurant notification
        if (restaurant.confirmation_email) {
            setImmediate(async () => {
                try {
                    await emailService.sendRestaurantNotification({
                        to: restaurant.confirmation_email,
                        subject: `Nouvelle réservation — ${guestName}`,
                        message: `Une réservation téléphonique vient d'être enregistrée.`,
                        bookingDetails: {
                            guest_name: guestName, guest_phone: guestPhone, guest_email: guestEmail || null,
                            booking_date: date, booking_time: normalizedTime, party_size: covers,
                            confirmation_number: booking.id, source: 'phone'
                        }
                    });
                } catch (err: any) { console.error('[create-booking] Restaurant notification:', err.message); }
            });
        }

        const successMessage = language === 'en'
            ? `Booking confirmed for ${firstName} ${lastName}, on ${date} at ${normalizedTime} for ${covers} ${covers > 1 ? 'guests' : 'guest'}.`
            : `Réservation confirmée pour ${firstName} ${lastName}, le ${date} à ${normalizedTime} pour ${covers} personne${covers > 1 ? 's' : ''}.`;

        const payload = {
            success: true,
            booking_id: booking.id,
            message: successMessage
        };
        return toolCall
            ? res.json({ results: [{ toolCallId: toolCall.id, result: JSON.stringify(payload) }] })
            : res.json(payload);
    } catch (error: any) {
        console.error('❌ create-booking error:', error);
        res.status(500).json({ success: false, message: 'Erreur lors de la création de la réservation.' });
    }
});


// ─────────────────────────────────────────────────────────────────────────────
// Existing event handlers (call lifecycle)
// ─────────────────────────────────────────────────────────────────────────────

async function handleCallStarted(event: any) {
    const { call, phoneNumber } = event;
    const phoneId = phoneNumber?.id || call?.phoneNumber?.id;
    const phoneNum = phoneNumber?.number || call?.phoneNumber?.number;

    let { data: restaurant } = await supabase
        .from('restaurants')
        .select('*')
        .eq('vapi_phone_id', phoneId || '')
        .single();

    if (!restaurant && phoneNum) {
        const fallbackLookup = await supabase
            .from('restaurants')
            .select('*')
            .eq('vapi_phone_number', phoneNum)
            .single();
        restaurant = fallbackLookup.data || null;
    }

    if (!restaurant) {
        console.error('Restaurant not found for phone:', { phoneId, phoneNum });
        return;
    }

    await supabase.from('call_logs').insert({
        restaurant_id: restaurant.id,
        call_id: call.id,
        caller_number: call.customer?.number,
        status: 'in_progress',
        started_at: new Date().toISOString()
    });
}

async function handleCallEnded(event: any) {
    const { call, transcript, recording } = event;
    const callId = call?.id;

    let phoneId, phoneNum;
    if (event.type === 'end-of-call-report') {
        phoneId = event.phoneNumber?.id || event.phone?.id;
        phoneNum = event.phoneNumber?.number || event.phone?.number;
        if (phoneNum && typeof phoneNum === 'object') {
            phoneNum = phoneNum.number || phoneNum.id;
        }
    } else {
        phoneId = call?.phoneNumber?.id || call?.phone?.id;
        phoneNum = call?.phoneNumber?.number || call?.phone?.number;
    }

    let rawDuration = event.durationSeconds || event.duration || call?.duration || call?.durationSeconds || 0;
    let duration = Math.round(Number(rawDuration) || 0);
    let finalTranscript = event.transcript || transcript || call?.transcript || '';
    let finalRecordingUrl = event.recordingUrl || recording?.url || call?.recordingUrl || '';
    let startedAt = event.startedAt || call?.startedAt;
    let endedAt = event.endedAt || call?.endedAt;

    // Extraction Structured Outputs VAPI
    const structuredOutputs = event.artifact?.structuredOutputs || {};
    const soValues = Object.values(structuredOutputs) as any[];

    const reservationBooked = soValues.find(v => typeof v === 'boolean' && v !== null) ?? null;
    const bookingDetails = soValues.find(v => typeof v === 'object' && v !== null && !Array.isArray(v)) ?? null;
    const appointmentDate = bookingDetails?.date ?? null;
    const appointmentTime = bookingDetails?.time ?? null;
    const callSummary = soValues.find(v => typeof v === 'string' && v.length > 20) ?? null;
    const successEvaluation = (() => {
        const entry = Object.entries(structuredOutputs).find(([k]) => k.toLowerCase().includes('success'));
        return entry ? (entry[1] as boolean | null) : null;
    })();
    const customerSentiment = soValues.find(v => ['positive','neutral','negative'].includes(v as string)) ?? null;

    if (!duration && startedAt && endedAt) {
        const start = new Date(startedAt).getTime();
        const end = new Date(endedAt).getTime();
        if (end > start) {
            duration = Math.floor((end - start) / 1000);
        }
    }

    console.log('Processing call end event:', {
        type: event.type, callId, phoneId, phoneNum,
        extractedDuration: duration, hasTranscript: !!finalTranscript, hasRecording: !!finalRecordingUrl
    });

    try {
        const { data: updated, error: updateError } = await supabase
            .from('call_logs')
            .update({
                status: 'completed',
                duration,
                transcript: finalTranscript,
                recording_url: finalRecordingUrl,
                ended_at: endedAt || new Date().toISOString(),
                // ✅ Structured Outputs
                reservation_booked: reservationBooked,
                booking_details: bookingDetails,
                appointment_date: appointmentDate,
                appointment_time: appointmentTime,
                call_summary: callSummary,
                success_evaluation: successEvaluation,
                customer_sentiment: customerSentiment,
                raw_payload: event
            })
            .eq('call_id', callId)
            .select('id, restaurant_id');

        const hasUpdated = Array.isArray(updated) && updated.length > 0;

        if (!hasUpdated) {
            let { data: restaurant } = await supabase
                .from('restaurants')
                .select('*')
                .eq('vapi_phone_id', phoneId || '')
                .single();

            if (!restaurant && phoneNum) {
                const fallbackLookup = await supabase
                    .from('restaurants')
                    .select('*')
                    .eq('vapi_phone_number', phoneNum)
                    .single();
                restaurant = fallbackLookup.data || null;
            }

            if (restaurant) {
                const finalStartedAt = startedAt
                    ? new Date(startedAt).toISOString()
                    : new Date(Date.now() - (duration || 0) * 1000).toISOString();

                const { error: insertError } = await supabase.from('call_logs').insert({
                    restaurant_id: restaurant.id,
                    call_id: callId,
                    caller_number: call?.customer?.number,
                    status: 'completed',
                    duration,
                    transcript: finalTranscript,
                    recording_url: finalRecordingUrl,
                    started_at: finalStartedAt,
                    ended_at: endedAt || new Date().toISOString(),
                    // ✅ Structured Outputs
                    reservation_booked: reservationBooked,
                    booking_details: bookingDetails,
                    appointment_date: appointmentDate,
                    appointment_time: appointmentTime,
                    call_summary: callSummary,
                    success_evaluation: successEvaluation,
                    customer_sentiment: customerSentiment,
                    raw_payload: event
                });

                if (insertError) console.error('Call log insert error:', insertError);
                else console.log('Call log cleanly inserted.');
            } else {
                console.error('Restaurant not found for call.ended fallback:', { phoneId, phoneNum });
            }
        } else if (updateError) {
            console.error('Call log update error:', updateError);
        }
    } catch (error) {
        console.error('Call ended handling error:', error);
    }
}

/**
 * Handle function calls from VAPI (legacy single-function-call format)
 */
async function handleFunctionCall(event: any, res: Response) {
    const { functionName, parameters, call } = event;
    const callerPhone = call?.customer?.number;

    console.log(`Function call: ${functionName}`, parameters);

    const { data: restaurant } = await supabase
        .from('restaurants')
        .select('*')
        .eq('vapi_assistant_id', call.assistantId)
        .single();

    if (!restaurant) {
        return res.json({ error: 'Restaurant not found' });
    }

    return res.json(await executeFunctionCall(functionName, restaurant, parameters, callerPhone));
}

/**
 * Handle assistant-request to inject dynamic overrides (Date/Time)
 */
async function handleAssistantRequest(event: any, res: Response) {
    const call = event.call;
    const phoneId = call?.phoneNumberId || event.phoneNumber?.id;
    const phoneNum = call?.phoneNumber || event.phoneNumber?.number;

    let { data: restaurant } = await supabase
        .from('restaurants')
        .select('*')
        .eq('vapi_phone_id', phoneId || '')
        .single();

    if (!restaurant && phoneNum) {
        const fallback = await supabase
            .from('restaurants')
            .select('*')
            .eq('vapi_phone_number', phoneNum)
            .single();
        restaurant = fallback.data || null;
    }

    if (!restaurant) {
        return res.json({ error: 'Restaurant not found' });
    }

    const now = new Date();
    const currentDate = now.toISOString().split('T')[0];
    const currentTime = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', hour12: false });
    const dayOfWeek = now.toLocaleDateString('fr-FR', { weekday: 'long' });

    console.log(`Injecting dynamic prompt for ${restaurant.name}:`, { currentDate, currentTime, dayOfWeek });

    const basePrompt = vapiService.generateSystemPrompt();
    const dynamicContext = `\n\nDONNÉES EN TEMPS RÉEL (NE PAS IGNORER) :\n- Date du jour : ${currentDate} (${dayOfWeek})\n- Heure actuelle : ${currentTime}\n- ID du restaurant : ${restaurant.id}\n\nUtilise ces informations pour résoudre les termes relatifs comme "demain", "ce soir", "vendredi prochain". L'année est ${now.getFullYear()}.`;

    return res.json({
        assistant: {
            model: {
                systemPrompt: basePrompt + dynamicContext
            },
            firstMessage: (() => {
                const h = new Date().getHours();
                const g = h < 18 ? 'Bonjour' : 'Bonsoir';
                return `${g} et bienvenue chez ${restaurant.name}, comment puis-je vous aider ?`;
            })(),
            variableValues: {
                restaurantName: restaurant.name,
                address: restaurant.address || '',
                humanPhone: restaurant.phone || '',
                openingHours: vapiService.formatOpeningHours(restaurant.opening_hours),
                restaurantId: restaurant.id
            }
        }
    });
}

/**
 * Handle tool-calls batch from VAPI (webhook fallback)
 */
async function handleToolCalls(event: any, res: Response) {
    try {
        const { call, toolCalls = [] } = event;
        if (!toolCalls.length) {
            return res.json({ toolResults: [] });
        }

        console.log('Received tool-calls via webhook:', JSON.stringify({ call, toolCalls }, null, 2));

        const assistantId = call?.assistantId || event.assistantId || event.assistant?.id;
        const phoneId = event.phoneNumber?.id || call?.phoneNumber?.id;

        let { data: restaurant } = await supabase
            .from('restaurants')
            .select('*')
            .eq('vapi_assistant_id', assistantId || '')
            .single();

        if (!restaurant && phoneId) {
            const lookup = await supabase
                .from('restaurants')
                .select('*')
                .eq('vapi_phone_id', phoneId)
                .single();
            restaurant = lookup.data || null;
        }

        if (!restaurant) {
            return res.json({
                toolResults: toolCalls.map((tc: any) => ({
                    toolCallId: tc.id,
                    result: { error: 'Restaurant not found' }
                }))
            });
        }

        const toolResults: any[] = [];
        for (const tc of toolCalls) {
            const functionName = tc.function?.name || tc.name;
            let params: any = {};
            try {
                const rawArgs = tc.function?.arguments || tc.parameters || tc.function?.input || '{}';
                params = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
            } catch {
                toolResults.push({ toolCallId: tc.id, result: { error: 'Invalid parameters' } });
                continue;
            }

            const result = await executeFunctionCall(functionName, restaurant, params, call?.customer?.number);
            toolResults.push({ toolCallId: tc.id, result });
        }

        res.json({
            toolResults,
            results: toolResults.map(tr => ({ toolCallId: tr.toolCallId, result: tr.result })),
            result: toolResults[0]?.result
        });
    } catch (error: any) {
        console.error('VAPI tool-calls error:', error);
        res.status(500).json({ error: 'Tool handling failed' });
    }
}

/**
 * Shared executor for function calls (webhook fallback path)
 */
async function executeFunctionCall(functionName: string, restaurant: any, parameters: any, callerPhone?: string) {
    // Normalize param names: covers/partySize, first_name+last_name/guestName
    const normalizedParams = { ...parameters };
    if (normalizedParams.covers && !normalizedParams.partySize) {
        normalizedParams.partySize = normalizedParams.covers;
    }
    if (normalizedParams.first_name || normalizedParams.last_name) {
        normalizedParams.guestName = `${normalizedParams.first_name || ''} ${normalizedParams.last_name || ''}`.trim();
    }
    if (normalizedParams.phone && !normalizedParams.guestPhone) {
        normalizedParams.guestPhone = normalizedParams.phone;
    }

    switch (functionName) {
        case 'check_availability':
            return await checkAvailability(restaurant.id, restaurant, normalizedParams);
        case 'create_booking':
            return await createBooking(restaurant.id, restaurant, normalizedParams, callerPhone);
        case 'update_booking':
            return await updateBooking(restaurant.id, restaurant, normalizedParams);
        case 'cancel_booking':
            return await cancelBooking(restaurant.id, restaurant, normalizedParams);
        default:
            return { error: 'Unknown function' };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool implementations (used by webhook fallback path)
// ─────────────────────────────────────────────────────────────────────────────

async function checkAvailability(restaurantId: string, restaurant: any, params: any) {
    const { date, time, partySize } = params;
    const covers = parseInt(partySize, 10);
    console.log(`🔍 Checking ${restaurantId}: ${date} ${time} x${covers} covers`);

    try {
        const { data: closed } = await supabase
            .from('closed_dates')
            .select('reason')
            .eq('restaurant_id', restaurantId)
            .eq('closed_on', date)
            .maybeSingle();

        if (closed) {
            return {
                result: 'unavailable',
                message: `Le restaurant est fermé le ${date}. ${closed.reason || 'Souhaitez-vous essayer une autre date ?'}`
            };
        }

        const { data: slots, error } = await supabase.rpc('get_available_slots', {
            p_restaurant_id: restaurantId,
            p_date: date,
            p_covers: covers
        });

        if (error) {
            console.error('❌ get_available_slots error:', error);
            return { result: 'error', message: 'Impossible de vérifier la disponibilité.' };
        }

        const slotMatch = (slots as any[] || []).find(s => s.slot_time?.slice(0, 5) === time);

        if (!slotMatch) {
            return {
                result: 'unavailable',
                message: `Pas de disponibilité à ${time} le ${date}.`
            };
        }

        if (!slotMatch.available) {
            return {
                result: 'unavailable',
                remaining: slotMatch.remaining,
                message: `Le créneau de ${time} est complet pour ${covers} personne${covers > 1 ? 's' : ''}.`
            };
        }

        console.log(`✅ Available at ${time} — ${slotMatch.remaining} covers remaining`);
        return {
            result: 'available',
            booked_for: slotMatch.slot_datetime,
            remaining: slotMatch.remaining,
            message: `Disponibilité confirmée pour ${covers} personne${covers > 1 ? 's' : ''} le ${date} à ${time}.`
        };
    } catch (err) {
        console.error('❌ Availability check failed:', err);
        return { result: 'error', message: 'Impossible de vérifier la disponibilité.' };
    }
}

async function createBooking(restaurantId: string, restaurant: any, params: any, callerPhone?: string) {
    const { guestName, guestEmail, guestPhone, date, time, partySize, specialRequests } = params;
    const covers = parseInt(partySize, 10);
    const normalizedTime = normalizeTime(time);
    const language: 'fr' | 'en' = params.language === 'en' ? 'en' : 'fr';

    try {
        const phoneKey = callerPhone || guestPhone;
        let customerId: string | null = null;
        if (phoneKey) {
            const { data: existing } = await supabase
                .from('customers')
                .select('id')
                .eq('restaurant_id', restaurantId)
                .eq('phone', phoneKey)
                .single();
            if (existing) {
                customerId = existing.id;
            } else {
                const { data: created } = await supabase
                    .from('customers')
                    .insert({ restaurant_id: restaurantId, phone: phoneKey, name: guestName || null, email: guestEmail || null })
                    .select('id')
                    .single();
                customerId = created?.id || null;
            }
        }

        const bookedFor = `${date}T${normalizedTime}:00`;
        const { data: booking, error: insertError } = await supabase
            .from('bookings')
            .insert({
                restaurant_id: restaurantId,
                customer_id: customerId,
                booked_for: bookedFor,
                covers,
                special_requests: specialRequests || null,
                source: 'vapi',
                status: 'confirmed',
                call_id: null,
                guest_language: language
            })
            .select()
            .single();

        if (insertError || !booking) {
            console.error('[create_booking] Insert error:', insertError);
            return {
                success: false,
                message: language === 'en' ? 'Could not create the booking.' : 'Impossible de créer la réservation.'
            };
        }

        console.log(`✅ Booking created: ${booking.id} — customer: ${customerId}`);

        // Non-blocking: Google Calendar
        if (restaurant.google_calendar_tokens) {
            setImmediate(async () => {
                try {
                    const tokens = JSON.parse(restaurant.google_calendar_tokens);
                    const startTime = new Date(`${date}T${normalizedTime}:00`);
                    const endTime = new Date(startTime.getTime() + 90 * 60000);
                    const gCalEvent = await calendarService.createEvent(tokens, {
                        summary: `[TableNow] ${guestName} — ${covers} pers.`,
                        description: `📞 ${guestPhone}\n${guestEmail ? '📧 ' + guestEmail : ''}`,
                        start: startTime, end: endTime,
                        attendees: guestEmail ? [guestEmail] : []
                    });
                    if (gCalEvent?.id) await supabase.from('bookings').update({ google_calendar_event_id: gCalEvent.id }).eq('id', booking.id);
                } catch (err: any) { console.error('[create_booking] Calendar:', err.message); }
            });
        }

        // Non-blocking: Email (in caller's language)
        if (guestEmail) {
            setImmediate(async () => {
                try {
                    await emailService.sendBookingConfirmation({
                        to: guestEmail, restaurantName: restaurant.name,
                        restaurantAddress: restaurant.address || '',
                        restaurantPhone: restaurant.phone || '',
                        guestName,
                        date, time: normalizedTime || time, partySize: covers, confirmationNumber: booking.id,
                        language
                    });
                    await supabase.from('bookings').update({ confirmation_email_sent: true }).eq('id', booking.id);
                } catch (err: any) { console.error('[create_booking] Guest email:', err.message); }
            });
        }

        // Non-blocking: Restaurant notification
        if (restaurant.confirmation_email) {
            setImmediate(async () => {
                try {
                    await emailService.sendRestaurantNotification({
                        to: restaurant.confirmation_email,
                        subject: `Nouvelle réservation — ${guestName}`,
                        message: `Une réservation téléphonique vient d'être enregistrée.`,
                        bookingDetails: {
                            guest_name: guestName, guest_phone: guestPhone, guest_email: guestEmail || null,
                            booking_date: date, booking_time: normalizedTime || time, party_size: covers,
                            confirmation_number: booking.id, source: 'vapi'
                        }
                    });
                } catch (err: any) { console.error('[create_booking] Restaurant notification:', err.message); }
            });
        }

        const successMessage = language === 'en'
            ? `Booking confirmed for ${covers} ${covers > 1 ? 'guests' : 'guest'} on ${date} at ${normalizedTime || time} under the name ${guestName}.`
            : `Réservation confirmée pour ${covers} personne${covers > 1 ? 's' : ''} le ${date} à ${normalizedTime || time} au nom de ${guestName}.`;

        return {
            success: true,
            reservation_id: booking.id,
            message: successMessage
        };
    } catch (err: any) {
        console.error('[create_booking] Critical error:', err);
        return {
            success: false,
            message: language === 'en' ? 'Technical error.' : 'Erreur technique.'
        };
    }
}

async function updateBooking(restaurantId: string, restaurant: any, params: any) {
    const { confirmationNumber, ...updates } = params;
    if (updates.time) updates.time = normalizeTime(updates.time);

    let { data: booking, error } = await supabase
        .from('bookings')
        .update(updates)
        .eq('restaurant_id', restaurantId)
        .eq('confirmation_number', confirmationNumber)
        .select()
        .single();

    if ((error || !booking) && !updates.id) {
        const fallback = await supabase
            .from('bookings')
            .update(updates)
            .eq('confirmation_number', confirmationNumber)
            .select()
            .single();
        booking = fallback.data as any;
        error = fallback.error as any;
    }

    if (error || !booking) {
        return { success: false, message: 'Réservation non trouvée.' };
    }

    if (restaurant.google_calendar_tokens && booking.calendar_event_id && (updates.date || updates.time)) {
        try {
            const tokens = JSON.parse(restaurant.google_calendar_tokens);
            const newDate = updates.date || booking.booking_date;
            const newTime = updates.time || booking.booking_time;
            const startTime = new Date(`${newDate}T${newTime}:00`);
            const endTime = new Date(startTime.getTime() + 90 * 60000);
            await calendarService.updateEvent(tokens, booking.calendar_event_id, {
                start: startTime, end: endTime,
                summary: `Reservation: ${booking.guest_name} (${updates.partySize || booking.party_size} pers.)`
            });
        } catch (err) {
            console.error('⚠️ Google Calendar update error:', err);
        }
    }

    return { success: true, message: 'Réservation modifiée avec succès.' };
}

async function cancelBooking(restaurantId: string, restaurant: any, params: any) {
    const { confirmationNumber } = params;

    let { data: booking } = await supabase
        .from('bookings')
        .select('*')
        .eq('restaurant_id', restaurantId)
        .eq('confirmation_number', confirmationNumber)
        .single();

    if (!booking) {
        const fallback = await supabase
            .from('bookings')
            .select('*')
            .eq('confirmation_number', confirmationNumber)
            .single();
        booking = fallback.data || null;
    }

    if (!booking) {
        return { success: false, message: 'Réservation non trouvée.' };
    }

    const { error } = await supabase
        .from('bookings')
        .update({ status: 'cancelled' })
        .eq('id', booking.id);

    if (error) {
        return { success: false, message: 'Impossible d\'annuler la réservation.' };
    }

    if (restaurant.google_calendar_tokens && booking.calendar_event_id) {
        try {
            const tokens = JSON.parse(restaurant.google_calendar_tokens);
            await calendarService.deleteEvent(tokens, booking.calendar_event_id);
        } catch (err) {
            console.error('⚠️ Google Calendar delete error:', err);
        }
    }

    return { success: true, message: 'Réservation annulée avec succès.' };
}

export default router;

function normalizeTime(timeStr?: string): string | undefined {
    if (!timeStr) return timeStr;
    if (/^\d{2}:\d{2}$/.test(timeStr)) return timeStr;
    const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?/);
    if (!match) return timeStr;
    let [_, hh, mm, mer] = match;
    let hour = parseInt(hh, 10);
    if (mer) {
        const upper = mer.toUpperCase();
        if (upper === 'PM' && hour < 12) hour += 12;
        if (upper === 'AM' && hour === 12) hour = 0;
    }
    return `${hour.toString().padStart(2, '0')}:${mm}`;
}
