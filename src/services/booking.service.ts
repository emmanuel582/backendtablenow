import supabase from '../config/supabase';
import logger from '../lib/logger';
import { DatabaseError, NotFoundError, ConflictError } from '../lib/errors';
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

// ─── Create (unified endpoint) ────────────────────────────────────────────────
// KEEP PUBLIC CONTRACT: POST /api/bookings handles all booking creation
// Supports both manual (dashboard) and VAPI creation with unified logic

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

export async function createBooking(input: UnifiedCreateBookingInput, correlationId?: string) {
    const {
        restaurant_id, date, time, covers,
        guest_name, guest_email, guest_phone,
        special_requests, source, guest_language = 'fr',
        idempotency_key
    } = input;

    const log = logger.child({ correlationId, restaurant_id, date, time, covers, source });

    // Idempotency check — prevent duplicate bookings on VAPI retry
    if (idempotency_key) {
        const { data: existing } = await supabase
            .from('bookings')
            .select('id, status')
            .eq('restaurant_id', restaurant_id)
            .eq('call_id', idempotency_key)
            .maybeSingle();

        if (existing) {
            log.info({ bookingId: existing.id }, 'Idempotent booking — returning existing');
            return existing;
        }
    }

    const bookedFor = `${date}T${time}:00`;

    // Upsert customer (if phone provided)
    let customerId: string | null = null;
    if (guest_phone) {
        const { data: existing } = await supabase
            .from('customers')
            .select('id')
            .eq('restaurant_id', restaurant_id)
            .eq('phone', guest_phone)
            .maybeSingle();

        if (existing) {
            customerId = existing.id;
        } else {
            const { data: created } = await supabase
                .from('customers')
                .insert({ restaurant_id, phone: guest_phone, name: guest_name, email: guest_email || null })
                .select('id')
                .single();
            customerId = created?.id || null;
        }
    }

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
            call_id:       idempotency_key || null,
            guest_language: guest_language
        })
        .select()
        .single();

    if (error || !booking) {
        log.error({ error }, 'Booking insert failed');
        throw new DatabaseError('Failed to create booking', error);
    }

    log.info({ bookingId: booking.id, source }, 'Booking created');
    return booking;
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
