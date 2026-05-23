import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import supabase from '../config/supabase';
import emailService from '../services/email.service';
import vapiService from '../services/vapi.service';
import logger from '../lib/logger';
import calendarService from '../services/calendar.service';
import { validate } from '../middleware/handlers';
import { VapiWebhookPayloadSchema } from '../schemas/vapiWebhookSchema';
import vapiController from '../controllers/vapi.controller';
import phoneResolutionService from '../services/phoneResolution.service';
import { createBooking } from '../services/booking.service';
import bookingOrchestrationService from '../services/voice/bookingOrchestration.service';
import { validateBookingPayload } from '../services/voice/vapiBookingPayload.validator';
import type { VoiceSessionState, ResolvedVoiceRestaurant } from '../types/voice.types';

const router = Router();

/**
 * Verify VAPI webhook signature using HMAC-SHA256
 * Prevents attackers from faking booking events
 * SECURITY: KEEP PUBLIC CONTRACT - signature required
 */
function verifyVapiSignature(req: Request, secret: string): boolean {
    const signature = req.headers['x-vapi-signature'] as string;

    if (!signature) {
        logger.warn({ action: 'vapi_webhook_verify' }, 'VAPI webhook missing signature header');
        return false;
    }

    try {
        // Reconstruct the signed payload (body + timestamp)
        const timestamp = req.headers['x-vapi-timestamp'] as string;
        const nonce = req.headers['x-vapi-nonce'] as string;

        if (!timestamp || !nonce) {
            logger.warn({ action: 'vapi_webhook_verify' }, 'VAPI webhook missing timestamp or nonce');
            return false;
        }

        // Build the signed content: timestamp.nonce.body
        const body = JSON.stringify(req.body);
        const signedContent = `${timestamp}.${nonce}.${body}`;

        // Calculate expected signature using timing-safe comparison
        const expectedSignature = crypto
            .createHmac('sha256', secret)
            .update(signedContent)
            .digest('hex');

        // Use timingSafeEqual to prevent timing attacks
        const signatureBuffer = Buffer.from(signature, 'hex');
        const expectedBuffer = Buffer.from(expectedSignature, 'hex');

        if (signatureBuffer.length !== expectedBuffer.length) {
            logger.warn({ action: 'vapi_webhook_verify' }, 'VAPI signature length mismatch');
            return false;
        }

        return crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
    } catch (err: any) {
        logger.error({ action: 'vapi_webhook_verify', error: err.message }, 'VAPI signature verification error');
        return false;
    }
}

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
// SECURITY: Verifies HMAC-SHA256 signature before processing
// ─────────────────────────────────────────────────────────────────────────────
router.post('/webhook', validate(VapiWebhookPayloadSchema), async (req: Request, res: Response) => {
    try {
        // Verify VAPI webhook signature (SECURITY CRITICAL)
        const secret = process.env.VAPI_WEBHOOK_SECRET;
        if (!secret) {
            logger.error({ action: 'vapi_webhook' }, 'VAPI_WEBHOOK_SECRET not configured');
            return res.status(500).json({ error: 'Server misconfiguration' });
        }

        if (!verifyVapiSignature(req, secret)) {
            logger.warn({ action: 'vapi_webhook' }, 'VAPI webhook signature verification failed - rejecting request');
            return res.status(401).json({ error: 'Unauthorized: Invalid signature' });
        }

        const event = req.body.message || req.body;
        logger.info({ action: 'vapi_webhook_received', event_type: event.type }, 'VAPI webhook verified and received');

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
                logger.info({ action: 'vapi_webhook_end_of_call', event_type: event.type }, 'Processing end-of-call-report event');
                await handleCallEnded(event);
                break;
            default:
                logger.warn({ action: 'vapi_webhook_unhandled', event_type: event.type }, 'Unhandled event type');
        }

        res.json({ received: true });
    } catch (error: any) {
        logger.error({ action: 'vapi_webhook', error: error.message }, 'VAPI webhook error');
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /assistant-config — Dynamic variable injection per call
// VAPI calls this on each incoming call to fill {{variable}} placeholders
// ─────────────────────────────────────────────────────────────────────────────
router.post('/assistant-config', async (req: Request, res: Response) => {
    return vapiController.handleAssistantConfig(req, res);
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

    // Defensive validation BEFORE we ever synthesize a VoiceSessionState with
    // status='confirmed'. We MUST NOT trust that VAPI only fires this hook
    // post-collection — a malformed or premature call must be rejected here,
    // not promoted to a confirmed slot and slipped past the orchestration gates.
    const validation = validateBookingPayload({
        restaurantId,
        date,
        time,
        covers,
        firstName,
        lastName,
        guestPhone,
        guestEmail,
    });

    if (!validation.valid) {
        console.warn('⚠️ create-booking rejected — incomplete/invalid payload', {
            missing: validation.missing,
            invalid: validation.invalid,
            callId: message?.call?.id,
        });
        const payload = {
            success: false,
            status: 'needs_clarification' as const,
            message: validation.message,
            missing: validation.missing,
            invalid: validation.invalid,
        };
        return toolCall
            ? res.json({ results: [{ toolCallId: toolCall.id, result: JSON.stringify(payload) }] })
            : res.status(400).json(payload);
    }

    // Use normalized values from the validator (trimmed, parsed) from here on.
    ({ restaurantId, date, time, covers, firstName, lastName, guestPhone } = validation.data);
    guestEmail = validation.data.guestEmail || '';

    const guestName = `${firstName} ${lastName}`.trim();

    // Resolve slug to UUID if needed
    const resolvedId = await resolveRestaurantId(restaurantId);
    if (!resolvedId) {
        const payload = { success: false, message: 'Restaurant non trouvé.' };
        return toolCall
            ? res.json({ results: [{ toolCallId: toolCall.id, result: JSON.stringify(payload) }] })
            : res.status(404).json(payload);
    }

    // Booking trace — redact PII (no name, no full phone) for GDPR-safe logs.
    // We keep correlation IDs (restaurant + call + date/time/covers) for debugging.
    const phoneRedacted = guestPhone
        ? `${guestPhone.slice(0, 3)}******${guestPhone.slice(-2)}`
        : 'none';
    console.log('📝 create-booking', {
        restaurant_id: resolvedId,
        call_id: message?.call?.id || null,
        date,
        time,
        covers,
        customer_present: true,
        phone_redacted: phoneRedacted,
        email_present: !!guestEmail,
    });

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

    // Normalize time
    const normalizedTime = normalizeTime(time) || time;

    // Build VoiceSessionState from VAPI tool-call params.
    // VAPI gathered fields via conversation → mark as 'confirmed' for orchestration gates.
    const callId = message?.call?.id || `vapi-create-booking-${Date.now()}`;
    const session: VoiceSessionState = {
        call_id: callId,
        restaurant_id: resolvedId,
        intent: 'new_booking',
        language,
        slots: {
            first_name: { value: firstName, status: 'confirmed', source: 'user_input' },
            last_name: { value: lastName, status: 'confirmed', source: 'user_input' },
            phone: { value: guestPhone, status: 'confirmed', source: 'user_input' },
            guest_count: { value: covers, status: 'confirmed', source: 'user_input' },
            date: { value: date, status: 'confirmed', source: 'user_input' },
            time: { value: normalizedTime, status: 'confirmed', source: 'user_input' },
            email: { value: guestEmail || null, status: guestEmail ? 'confirmed' : 'missing', source: guestEmail ? 'user_input' : 'unknown' },
        },
        confirmation_status: 'confirmed',
        backend_action_status: 'idle',
    };

    const voiceRestaurant: ResolvedVoiceRestaurant = {
        id: resolvedId,
        name: restaurant.name,
        slug: restaurant.slug || '',
        address: restaurant.address || '',
        phone: restaurant.phone || '',
        opening_hours: restaurant.opening_hours,
        language,
    };

    try {
        const result = await bookingOrchestrationService.orchestrateBooking(voiceRestaurant, session);

        if (result.status === 'success') {
            console.log(`✅ Booking created via orchestration: ${result.booking_id}`);
            const payload = { success: true, booking_id: result.booking_id, message: result.message };
            return toolCall
                ? res.json({ results: [{ toolCallId: toolCall.id, result: JSON.stringify(payload) }] })
                : res.json(payload);
        }

        // Orchestration returned a non-success status (unavailable / failed / needs_clarification)
        const httpStatus = result.status === 'unavailable' ? 409 : 422;
        const payload: Record<string, unknown> = { success: false, message: result.message };
        if (result.status === 'unavailable') payload.alternatives = result.alternatives;
        if (result.status === 'failed') payload.reason = result.reason;

        return toolCall
            ? res.json({ results: [{ toolCallId: toolCall.id, result: JSON.stringify(payload) }] })
            : res.status(httpStatus).json(payload);
    } catch (error: any) {
        console.error('❌ create-booking error:', error);
        return res.status(500).json({ success: false, message: 'Erreur lors de la création de la réservation.' });
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
            return await createBookingTool(restaurant.id, restaurant, normalizedParams, callerPhone);
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

async function createBookingTool(restaurantId: string, restaurant: any, params: any, callerPhone?: string) {
    const { guestName, guestEmail, guestPhone, date, time, partySize, specialRequests } = params;
    const covers = parseInt(partySize, 10);
    const normalizedTime = normalizeTime(time) || time;
    const language: 'fr' | 'en' = params.language === 'en' ? 'en' : 'fr';

    try {
        if (!date || !normalizedTime) {
            throw new Error('Missing required booking parameters: date or time');
        }

        const phoneKey = callerPhone || guestPhone;

        const booking = await createBooking(
            {
                restaurant_id: restaurantId,
                date,
                time: normalizedTime,
                covers,
                guest_name: guestName || 'Guest',
                guest_email: guestEmail || null,
                guest_phone: phoneKey || null,
                special_requests: specialRequests || null,
                source: 'phone',
                guest_language: language
            },
            'vapi-tool-call',
            {
                id: restaurantId,
                name: restaurant.name,
                address: restaurant.address || '',
                phone: restaurant.phone || '',
                google_calendar_tokens: restaurant.google_calendar_tokens
            }
        );

        console.log(`✅ Booking created: ${booking.id}`);

        const successMessage = language === 'en'
            ? `Booking confirmed for ${covers} ${covers > 1 ? 'guests' : 'guest'} on ${date} at ${normalizedTime || time} under the name ${guestName}.`
            : `Réservation confirmée pour ${covers} personne${covers > 1 ? 's' : ''} le ${date} à ${normalizedTime || time} au nom de ${guestName}.`;

        return {
            success: true,
            reservation_id: booking.id,
            message: successMessage
        };
    } catch (err: any) {
        console.error('[createBookingTool] Critical error:', err);
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
