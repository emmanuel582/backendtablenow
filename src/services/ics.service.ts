import ical, { ICalEventStatus } from 'ical-generator';
import { zonedWallTimeToUtc } from '../lib/timezone';

/**
 * Universal calendar feed (iCalendar / .ics).
 *
 * This is the "any calendar, no limit" mechanism: any client that can subscribe
 * to an ICS URL — Google Calendar, Apple Calendar, Outlook, Thunderbird,
 * Fastmail, … — gets the restaurant's live reservations with zero per-vendor
 * OAuth. The feed is read-only and reflects the `bookings` source of truth.
 */

const DEFAULT_TZ = 'Europe/Paris';
const DEFAULT_DURATION_MIN = 90;

interface FeedRestaurant {
    name?: string | null;
    timezone?: string | null;
    default_duration_min?: number | null;
}

interface FeedBooking {
    id: string;
    booking_date?: string | null;
    booking_time?: string | null;
    booked_for?: string | null;
    party_size?: number | null;
    covers?: number | null;
    guest_name?: string | null;
    guest_phone?: string | null;
    guest_email?: string | null;
    special_requests?: string | null;
    confirmation_number?: string | null;
    status?: string | null;
    updated_at?: string | null;
}

export function buildIcsFeed(restaurant: FeedRestaurant, bookings: FeedBooking[]): string {
    const tz = restaurant?.timezone || DEFAULT_TZ;
    const durationMin = restaurant?.default_duration_min || DEFAULT_DURATION_MIN;

    const cal = ical({
        name: `${restaurant?.name || 'TableNow'} — Réservations`,
        timezone: tz,
        prodId: { company: 'TableNow', product: 'Reservations', language: 'FR' },
    });

    for (const b of bookings) {
        const start = b.booking_date && b.booking_time
            ? zonedWallTimeToUtc(b.booking_date, b.booking_time, tz)
            : b.booked_for ? new Date(b.booked_for) : null;
        if (!start || isNaN(start.getTime())) continue;

        const end = new Date(start.getTime() + durationMin * 60_000);
        const covers = b.party_size ?? b.covers ?? '';

        cal.createEvent({
            id: b.id,
            start,
            end,
            timezone: tz,
            summary: `${b.guest_name || 'Réservation'} — ${covers} couvert${Number(covers) > 1 ? 's' : ''}`,
            description: [
                b.guest_phone && `Tel : ${b.guest_phone}`,
                b.guest_email && `Email : ${b.guest_email}`,
                b.special_requests && `Note : ${b.special_requests}`,
                b.confirmation_number && `Réf : ${b.confirmation_number}`,
            ].filter(Boolean).join('\n'),
            status: b.status === 'cancelled' ? ICalEventStatus.CANCELLED : ICalEventStatus.CONFIRMED,
            lastModified: b.updated_at ? new Date(b.updated_at) : undefined,
        });
    }

    return cal.toString();
}

export default { buildIcsFeed };
