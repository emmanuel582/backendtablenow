import supabase from '../config/supabase';
import logger from '../lib/logger';
import { DatabaseError, NotFoundError, ConflictError } from '../lib/errors';
import bookingLogging from './bookingLogging.service';
import errorTracking from './errorTracking.service';
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

// NOTE: Customer upsert moved INTO create_booking_with_outbox() so it shares
// the same transaction as the booking + outbox insert.

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
        throw new ConflictError('idempotency_key is required');
    }

    // Determine which side-effect channels to queue (no PII in outbox)
    const channels: ('email' | 'calendar')[] = [];
    if (guest_email) channels.push('email');
    if (restaurant?.google_calendar_tokens) channels.push('calendar');

    // ATOMIC: booking + outbox events created in a SINGLE Postgres transaction.
    // The RPC create_booking_with_outbox() handles idempotency, customer upsert,
    // booking insert, and outbox insert. Either all commit or none do.
    const { data: result, error } = await supabase.rpc('create_booking_with_outbox', {
        p_restaurant_id:    restaurant_id,
        p_idempotency_key:  idempotency_key,
        p_booking_date:     date,
        p_booking_time:     time,
        p_covers:           covers,
        p_guest_name:       guest_name,
        p_guest_email:      guest_email || null,
        p_guest_phone:      guest_phone || null,
        p_special_requests: special_requests || null,
        p_source:           source,
        p_guest_language:   guest_language,
        p_correlation_id:   correlationId || idempotency_key,
        p_channels:         channels,
    });

    if (error || !result || result.length === 0) {
        log.error({ error }, 'create_booking_with_outbox failed');
        errorTracking.bookingCreationFailed({
            restaurant_id,
            reason: error?.message || 'database_error',
        });
        throw new DatabaseError('Failed to create booking', error);
    }

    const row = result[0];

    if (row.is_existing) {
        log.info({ bookingId: row.booking_id }, 'Idempotent booking — returning existing');
        return { id: row.booking_id, side_effects_status: row.side_effects_status };
    }

    log.info({ bookingId: row.booking_id, source, channels }, 'Booking + outbox created (atomic)');

    bookingLogging.bookingCreated({
        booking_id: row.booking_id,
        restaurant_id,
        source: source as 'manual' | 'phone' | 'web',
        date,
        time,
        covers,
    });

    // Contract: side-effects are async. Return immediately with status 'pending'.
    // Email/calendar are processed by the outbox worker — never block here,
    // never 500 because a side-effect failed after the booking committed.
    return { id: row.booking_id, side_effects_status: row.side_effects_status };
}

// NOTE: Synchronous side-effects (triggerBookingSideEffects) were REMOVED.
// Email + calendar are now handled asynchronously by the outbox worker
// (src/workers/outbox-worker.ts), driven by outbox_events created atomically
// inside create_booking_with_outbox(). This guarantees a booking is never
// lost because a side-effect failed, and side-effects are retried + leased.

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
