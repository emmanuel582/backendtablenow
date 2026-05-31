import supabase from '../config/supabase';
import logger from '../lib/logger';
import { DatabaseError, NotFoundError, ConflictError } from '../lib/errors';
import emailService from './email.service';
import calendarService from './calendar.service';
import bookingLogging from './bookingLogging.service';
import errorTracking from './errorTracking.service';
import outboxService from './outbox.service';
import type { CreateBookingInput, BookingQuery } from '../types/schemas';

// ─── Normalize ────────────────────────────────────────────────────────────────
// Single function to normalize any booking row to a consistent shape

export function normalizeBooking(b: any): any {
    let booking_date = b.booking_date;
    let booking_time = b.booking_time;

    if (!booking_date && b.booked_for) {
        const dt = new Date(b.booked_for);
        // Paris timezone offset
        const paris = new Date(dt.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
        booking_date = paris.toISOString().split('T')[0];
        booking_time = paris.toTimeString().slice(0, 5);
    }

    const customer = b.customers;
    return {
        id:              b.id,
        restaurant_id:   b.restaurant_id,
        status:          b.status,
        source:          b.source,
        booking_date,
        booking_time,
        party_size:      b.party_size ?? b.covers ?? null,
        guest_name:      b.guest_name  ?? customer?.name  ?? 'N/A',
        guest_email:     b.guest_email ?? customer?.email ?? null,
        guest_phone:     b.guest_phone ?? customer?.phone ?? null,
        special_requests:  b.special_requests,
        confirmation_number: b.confirmation_number,
        google_calendar_event_id: b.google_calendar_event_id,
        call_id:         b.call_id,
        created_at:      b.created_at,
        updated_at:      b.updated_at
    };
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function getBookings(restaurantId: string, query: BookingQuery) {
    const { status, date, limit, offset } = query;

    let q = supabase
        .from('bookings')
        .select('*, customers(name, email, phone)', { count: 'exact' })
        .eq('restaurant_id', restaurantId)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

    if (status) q = q.eq('status', status);
    if (date) q = q.or(`booking_date.eq.${date},booked_for.gte.${date}T00:00:00,booked_for.lte.${date}T23:59:59`);

    const { data, error, count } = await q;

    if (error) throw new DatabaseError('Failed to fetch bookings', error);

    return {
        bookings: (data || []).map(normalizeBooking),
        total: count ?? 0,
        limit,
        offset
    };
}

export async function getBookingById(id: string, restaurantId: string) {
    const { data, error } = await supabase
        .from('bookings')
        .select('*, customers(name, email, phone)')
        .eq('id', id)
        .eq('restaurant_id', restaurantId)
        .single();

    if (error || !data) throw new NotFoundError('Booking');
    return normalizeBooking(data);
}

// ─── Customer Upsert (shared) ─────────────────────────────────────────────────

async function upsertCustomer(restaurantId: string, name: string, phone: string, email?: string | null): Promise<string | null> {
    if (!phone) return null;

    try {
        const { data: existing } = await supabase
            .from('customers')
            .select('id')
            .eq('restaurant_id', restaurantId)
            .eq('phone', phone)
            .maybeSingle();

        if (existing) return existing.id;

        const { data: created } = await supabase
            .from('customers')
            .insert({ restaurant_id: restaurantId, phone, name, email: email || null })
            .select('id')
            .single();

        return created?.id ?? null;
    } catch (err) {
        logger.error({ restaurantId, phone, error: err instanceof Error ? err.message : 'unknown' }, 'Customer upsert error');
        return null;
    }
}

// ─── Create (unified endpoint) ────────────────────────────────────────────────
// KEEP PUBLIC CONTRACT: POST /api/bookings handles all booking creation
// Supports both manual (dashboard), voice (phone), and web creation with unified logic

interface UnifiedCreateBookingInput {
    restaurant_id: string;
    date: string;
    time: string;
    covers: number;
    guest_name: string;
    guest_email?: string | null;
    guest_phone?: string | null;
    special_requests?: string | null;
    source: 'manual' | 'phone' | 'web';
    guest_language?: 'fr' | 'en';
    idempotency_key?: string | null;
}

interface RestaurantEmailData {
    id: string;
    name: string;
    address?: string;
    phone?: string;
    google_calendar_tokens?: string | null;
}

export async function createBooking(
    input: UnifiedCreateBookingInput,
    correlationId?: string,
    restaurant?: RestaurantEmailData
) {
    const {
        restaurant_id, date, time, covers,
        guest_name, guest_email, guest_phone,
        special_requests, source, guest_language = 'fr',
        idempotency_key
    } = input;

    const log = logger.child({ correlationId, restaurant_id, date, time, covers, source });

    // REQUIRE idempotency_key
    if (!idempotency_key) {
        log.error({}, 'Missing idempotency_key (required for deduplication)');
        throw new Error('idempotency_key is required');
    }

    // Idempotency check — DB UNIQUE constraint will enforce this
    const { data: existing } = await supabase
        .from('bookings')
        .select('id, status')
        .eq('idempotency_key', idempotency_key)
        .maybeSingle();

    if (existing) {
        log.info({ bookingId: existing.id }, 'Idempotent booking — returning existing');
        return existing;
    }

    const bookedFor = `${date}T${time}:00`;

    // Upsert customer (if phone provided) — shared logic
    const customerId = await upsertCustomer(restaurant_id, guest_name, guest_phone!, guest_email);

    // Insert booking — write ALL canonical fields at creation time
    const { data: booking, error } = await supabase
        .from('bookings')
        .insert({
            restaurant_id,
            customer_id:   customerId,
            // Canonical fields
            booking_date:  date,
            booking_time:  time,
            party_size:    covers,
            guest_name:    guest_name,
            guest_email:   guest_email || null,
            guest_phone:   guest_phone || null,
            // Legacy fields (kept for backward compat)
            booked_for:    bookedFor,
            covers,
            special_requests: special_requests || null,
            source,
            status:        'confirmed',
            call_id:       idempotency_key,
            idempotency_key, // NEW: UNIQUE constraint in DB
            guest_language: guest_language
        })
        .select()
        .single();

    if (error || !booking) {
        log.error({ error }, 'Booking insert failed');
        errorTracking.bookingCreationFailed({
            restaurant_id,
            reason: error?.message || 'database_error',
        });
        throw new DatabaseError('Failed to create booking', error);
    }

    log.info({ bookingId: booking.id, source }, 'Booking created');

    bookingLogging.bookingCreated({
        booking_id: booking.id,
        restaurant_id,
        source: source as 'manual' | 'phone' | 'web',
        guest_name,
        guest_email: guest_email || undefined,
        date,
        time,
        covers,
    });

    // NEW: Create outbox events for async processing (no PII in payload)
    const channels: ('email' | 'calendar')[] = [];
    if (guest_email) channels.push('email');
    if (restaurant?.google_calendar_tokens) channels.push('calendar');

    if (channels.length > 0) {
        try {
            await outboxService.createOutboxEvents(
                booking.id,
                restaurant_id,
                correlationId || idempotency_key,
                channels
            );
            log.info({ eventCount: channels.length }, 'Outbox events created');
        } catch (err) {
            log.warn({ err }, 'Failed to create outbox events (will queue on next poll)');
        }
    }

    // DEPRECATED: Trigger email and calendar side effects (non-blocking)
    // TODO: Remove after outbox worker is stable
    if (restaurant) {
        triggerBookingSideEffects(restaurant, booking, guest_name, guest_email, guest_phone, covers, date, time, guest_language, log);
    }

    return booking;
}

// ─── Side Effects (email, calendar) ────────────────────────────────────────────

function triggerBookingSideEffects(
    restaurant: RestaurantEmailData,
    booking: any,
    guestName: string,
    guestEmail: string | null | undefined,
    guestPhone: string | null | undefined,
    partySize: number,
    date: string,
    time: string,
    language: string,
    log: any
) {
    setImmediate(async () => {
        if (guestEmail) {
            try {
                await emailService.sendBookingConfirmation({
                    to: guestEmail,
                    restaurantName: restaurant.name,
                    restaurantAddress: restaurant.address || '',
                    restaurantPhone: restaurant.phone || '',
                    guestName,
                    date,
                    time,
                    partySize,
                    confirmationNumber: booking.id,
                    language: language as 'fr' | 'en'
                });
            } catch (e) {
                log.warn({ err: e }, 'Confirmation email failed');
            }
        }

        if (restaurant.google_calendar_tokens) {
            try {
                const tokens = JSON.parse(restaurant.google_calendar_tokens);
                const start = new Date(`${date}T${time}`);
                const end = new Date(start.getTime() + 2 * 3600000);
                await calendarService.createEvent(tokens, {
                    summary: `${guestName} (${partySize} pers.)`,
                    description: `Tel: ${guestPhone} | Email: ${guestEmail}`,
                    start,
                    end,
                    attendees: guestEmail ? [guestEmail] : []
                });
            } catch (e) {
                log.warn({ err: e }, 'Calendar event failed');
            }
        }
    });
}

// ─── Create (VAPI path - legacy wrapper) ──────────────────────────────────────
// Kept for backward compatibility, delegates to unified createBooking

export async function createVapiBooking(input: CreateBookingInput, correlationId?: string) {
    const {
        restaurant_id, date, time, covers,
        first_name, last_name, phone, email,
        special_requests, idempotency_key
    } = input;

    const guestName = `${first_name} ${last_name}`.trim();

    return createBooking(
        {
            restaurant_id,
            date,
            time,
            covers,
            guest_name: guestName,
            guest_email: email,
            guest_phone: phone,
            special_requests,
            source: 'phone',
            guest_language: 'fr',
            idempotency_key
        },
        correlationId
    );
}

// ─── Cancel ───────────────────────────────────────────────────────────────────

export async function cancelBooking(id: string, restaurantId: string) {
    const booking = await getBookingById(id, restaurantId);

    if (booking.status === 'cancelled') {
        throw new ConflictError('Booking is already cancelled');
    }

    const { error } = await supabase
        .from('bookings')
        .update({ status: 'cancelled' })
        .eq('id', id);

    if (error) throw new DatabaseError('Failed to cancel booking', error);
    return { ...booking, status: 'cancelled' };
}
