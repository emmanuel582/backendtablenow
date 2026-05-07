import crypto from 'crypto';
import supabase from '../config/supabase';
import logger from '../lib/logger';
import { DatabaseError, NotFoundError, ConflictError } from '../lib/errors';
import { handlePostgresError } from '../lib/supabase.utils';
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

// ─── Core creation (handles idempotency + conflict detection) ────────────────

export async function createBookingCore(input: {
    restaurantId: string;
    date: string;        // YYYY-MM-DD
    time: string;        // HH:MM
    phone: string;
    guestName: string;
    guestEmail?: string;
    partySize: number;
    source: 'dashboard' | 'vapi' | 'webhook';
    specialRequests?: string;
    correlationId?: string;
}) {
    const { restaurantId, date, time, phone, guestName, guestEmail, partySize, source, specialRequests, correlationId } = input;
    const log = logger.child({ correlationId, restaurantId, source, date, time });

    // Generate idempotency key from restaurant_id + date + time + phone
    const idempotencyKey = crypto
        .createHash('sha256')
        .update(`${restaurantId}|${date}|${time}|${phone}`)
        .digest('hex');

    // Try to insert new booking
    const { data: booking, error } = await supabase
        .from('bookings')
        .insert({
            restaurant_id: restaurantId,
            booking_date: date,
            booking_time: time,
            party_size: partySize,
            guest_name: guestName,
            guest_email: guestEmail || null,
            guest_phone: phone || null,
            special_requests: specialRequests || null,
            source,
            status: 'confirmed',
            idempotency_key: idempotencyKey
        })
        .select()
        .single();

    // Handle UNIQUE constraint conflict (duplicate idempotency_key)
    if (error?.code === '23505') {
        log.info({ idempotencyKey }, 'Idempotent booking — fetching existing');
        const { data: existing, error: fetchError } = await supabase
            .from('bookings')
            .select('*')
            .eq('restaurant_id', restaurantId)
            .eq('idempotency_key', idempotencyKey)
            .single();

        if (fetchError) {
            log.error({ fetchError, idempotencyKey }, 'Failed to fetch existing booking after conflict');
            throw new DatabaseError('Booking conflict resolution failed', fetchError);
        }

        if (!existing) {
            log.error({ idempotencyKey }, 'UNIQUE conflict but no existing booking found');
            throw new DatabaseError('Data integrity error: conflict detected but booking not found', error);
        }

        log.info({ bookingId: existing.id, idempotencyKey }, 'Returning existing booking');
        return normalizeBooking(existing);
    }

    // Handle other database errors
    if (error) {
        const pgError = handlePostgresError(error);
        log.error({ error, pgError }, 'Booking insert failed');
        throw new DatabaseError(pgError.message, error);
    }

    if (!booking) {
        log.error({ idempotencyKey }, 'Booking insert succeeded but no data returned');
        throw new DatabaseError('Booking creation failed: no data returned', error);
    }

    log.info({ bookingId: booking.id, idempotencyKey }, 'Booking created');
    return normalizeBooking(booking);
}

// ─── Create (VAPI path) ───────────────────────────────────────────────────────

export async function createVapiBooking(input: CreateBookingInput, correlationId?: string) {
    const {
        restaurant_id, date, time, covers,
        first_name, last_name, phone, email,
        special_requests, idempotency_key
    } = input;

    const log = logger.child({ correlationId, restaurant_id, date, time, covers });

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

    const guestName = `${first_name} ${last_name}`.trim();
    const bookedFor = `${date}T${time}:00`;

    // Upsert customer
    let customerId: string | null = null;
    if (phone) {
        const { data: existing } = await supabase
            .from('customers')
            .select('id')
            .eq('restaurant_id', restaurant_id)
            .eq('phone', phone)
            .maybeSingle();

        if (existing) {
            customerId = existing.id;
        } else {
            const { data: created } = await supabase
                .from('customers')
                .insert({ restaurant_id, phone, name: guestName, email: email || null })
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
            guest_name:    guestName,
            guest_email:   email || null,
            guest_phone:   phone || null,
            // Legacy fields (kept for backward compat)
            booked_for:    bookedFor,
            covers,
            special_requests: special_requests || null,
            source:        'vapi',
            status:        'confirmed',
            call_id:       idempotency_key || null
        })
        .select()
        .single();

    if (error || !booking) {
        log.error({ error }, 'Booking insert failed');
        throw new DatabaseError('Failed to create booking', error);
    }

    log.info({ bookingId: booking.id }, 'Booking created');
    return booking;
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
