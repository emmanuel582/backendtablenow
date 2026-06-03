import supabase from '../config/supabase';
import logger from '../lib/logger';
import { zonedWallTimeToUtc } from '../lib/timezone';
import calendarService, { GoogleEventInput } from './calendar.service';

/**
 * Calendar fan-out orchestrator.
 *
 * The `bookings` table is TableNow's source of truth. This service pushes each
 * booking out to *every* external calendar a restaurant has connected
 * (calendar_connections), recording one row per (booking, connection) in
 * calendar_event_links. Any calendar app can additionally *subscribe* to the
 * restaurant's ICS feed (ics.service.ts) — no connection required.
 *
 * All entry points are fire-and-forget safe: failures are logged per connection
 * and never block the booking flow.
 */

const DEFAULT_TZ = 'Europe/Paris';
const DEFAULT_DURATION_MIN = 90;

interface Connection {
    id: string;
    restaurant_id: string;
    provider: string;
    account_email: string | null;
    calendar_id: string;
    tokens: any;
}

// ─── Provider adapters ──────────────────────────────────────────────────────
// Pluggable: add 'microsoft' etc. here. Pull-only clients use the ICS feed instead.

interface ProviderAdapter {
    create(conn: Connection, ev: GoogleEventInput): Promise<{ id: string; url?: string }>;
    update(conn: Connection, externalId: string, ev: GoogleEventInput): Promise<{ id: string; url?: string }>;
    remove(conn: Connection, externalId: string): Promise<void>;
}

const adapters: Record<string, ProviderAdapter> = {
    google: {
        create: (conn, ev) => calendarService.createEvent(conn.tokens, ev, conn.calendar_id),
        update: (conn, id, ev) => calendarService.updateEvent(conn.tokens, id, ev, conn.calendar_id),
        remove: (conn, id) => calendarService.deleteEvent(conn.tokens, id, conn.calendar_id),
    },
};

// ─── Context loading ────────────────────────────────────────────────────────

async function loadContext(bookingId: string) {
    const { data: booking } = await supabase
        .from('bookings')
        .select('*')
        .eq('id', bookingId)
        .single();
    if (!booking) return null;

    const { data: restaurant } = await supabase
        .from('restaurants')
        .select('id, name, timezone, default_duration_min, address')
        .eq('id', booking.restaurant_id)
        .single();

    const { data: connections } = await supabase
        .from('calendar_connections')
        .select('id, restaurant_id, provider, account_email, calendar_id, tokens')
        .eq('restaurant_id', booking.restaurant_id)
        .eq('status', 'active')
        .eq('sync_enabled', true);

    return { booking, restaurant, connections: (connections || []) as Connection[] };
}

function buildEvent(booking: any, restaurant: any): GoogleEventInput {
    const tz = restaurant?.timezone || DEFAULT_TZ;

    // Prefer the canonical wall-clock fields (always correct); fall back to the instant.
    const start = booking.booking_date && booking.booking_time
        ? zonedWallTimeToUtc(booking.booking_date, booking.booking_time, tz)
        : new Date(booking.booked_for);

    const durationMin = restaurant?.default_duration_min || DEFAULT_DURATION_MIN;
    const end = new Date(start.getTime() + durationMin * 60_000);

    const covers = booking.party_size ?? booking.covers ?? '';
    const description = [
        booking.guest_phone && `Tel : ${booking.guest_phone}`,
        booking.guest_email && `Email : ${booking.guest_email}`,
        booking.special_requests && `Note : ${booking.special_requests}`,
        booking.confirmation_number && `Réf : ${booking.confirmation_number}`,
        'Réservation via TableNow',
    ].filter(Boolean).join('\n');

    return {
        summary: `${booking.guest_name || 'Réservation'} — ${covers} couvert${Number(covers) > 1 ? 's' : ''}`,
        description,
        start,
        end,
        timeZone: tz,
        attendees: booking.guest_email ? [booking.guest_email] : [],
    };
}

/** Persist tokens that may have been silently refreshed during an API call. */
async function persistTokens(conn: Connection): Promise<void> {
    await supabase
        .from('calendar_connections')
        .update({ tokens: conn.tokens, last_synced_at: new Date().toISOString(), last_error: null, status: 'active' })
        .eq('id', conn.id);
}

async function markConnectionError(conn: Connection, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    await supabase
        .from('calendar_connections')
        .update({ last_error: message })
        .eq('id', conn.id);
}

// ─── Public entry points ────────────────────────────────────────────────────

/** Push a newly created booking to every connected calendar. */
export async function onBookingCreated(bookingId: string): Promise<void> {
    try {
        const ctx = await loadContext(bookingId);
        if (!ctx || ctx.connections.length === 0) return;

        const ev = buildEvent(ctx.booking, ctx.restaurant);

        await Promise.all(ctx.connections.map(async (conn) => {
            const adapter = adapters[conn.provider];
            if (!adapter) return;
            try {
                const result = await adapter.create(conn, ev);
                await supabase.from('calendar_event_links').upsert({
                    booking_id: bookingId,
                    connection_id: conn.id,
                    provider: conn.provider,
                    external_event_id: result.id,
                    external_event_url: result.url || null,
                    status: 'active',
                    last_error: null,
                    updated_at: new Date().toISOString(),
                }, { onConflict: 'booking_id,connection_id' });
                await persistTokens(conn);
            } catch (err) {
                logger.error({ err, bookingId, connectionId: conn.id }, 'Calendar create failed');
                await markConnectionError(conn, err);
            }
        }));
    } catch (err) {
        logger.error({ err, bookingId }, 'onBookingCreated failed');
    }
}

/** Reflect a date/time/details change on every linked external event (creating any missing ones). */
export async function onBookingUpdated(bookingId: string): Promise<void> {
    try {
        const ctx = await loadContext(bookingId);
        if (!ctx || ctx.connections.length === 0) return;

        const ev = buildEvent(ctx.booking, ctx.restaurant);

        const { data: links } = await supabase
            .from('calendar_event_links')
            .select('connection_id, external_event_id')
            .eq('booking_id', bookingId)
            .eq('status', 'active');

        const linkByConnection = new Map((links || []).map((l: any) => [l.connection_id, l.external_event_id]));

        await Promise.all(ctx.connections.map(async (conn) => {
            const adapter = adapters[conn.provider];
            if (!adapter) return;
            const externalId = linkByConnection.get(conn.id);
            try {
                if (externalId) {
                    await adapter.update(conn, externalId, ev);
                } else {
                    // Connection added after the booking, or earlier create failed — create now.
                    const result = await adapter.create(conn, ev);
                    await supabase.from('calendar_event_links').upsert({
                        booking_id: bookingId,
                        connection_id: conn.id,
                        provider: conn.provider,
                        external_event_id: result.id,
                        external_event_url: result.url || null,
                        status: 'active',
                        updated_at: new Date().toISOString(),
                    }, { onConflict: 'booking_id,connection_id' });
                }
                await persistTokens(conn);
            } catch (err) {
                logger.error({ err, bookingId, connectionId: conn.id }, 'Calendar update failed');
                await markConnectionError(conn, err);
            }
        }));
    } catch (err) {
        logger.error({ err, bookingId }, 'onBookingUpdated failed');
    }
}

/** Remove a cancelled booking's events from every connected calendar. */
export async function onBookingCancelled(bookingId: string): Promise<void> {
    try {
        const ctx = await loadContext(bookingId);
        if (!ctx) return;

        const { data: links } = await supabase
            .from('calendar_event_links')
            .select('id, connection_id, external_event_id, provider')
            .eq('booking_id', bookingId)
            .eq('status', 'active');
        if (!links || links.length === 0) return;

        const connById = new Map(ctx.connections.map((c) => [c.id, c]));

        await Promise.all(links.map(async (link: any) => {
            const conn = connById.get(link.connection_id);
            const adapter = adapters[link.provider];
            if (!conn || !adapter) return;
            try {
                await adapter.remove(conn, link.external_event_id);
                await supabase
                    .from('calendar_event_links')
                    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
                    .eq('id', link.id);
                await persistTokens(conn);
            } catch (err) {
                logger.error({ err, bookingId, connectionId: link.connection_id }, 'Calendar delete failed');
                await markConnectionError(conn, err);
            }
        }));
    } catch (err) {
        logger.error({ err, bookingId }, 'onBookingCancelled failed');
    }
}

export default { onBookingCreated, onBookingUpdated, onBookingCancelled };
