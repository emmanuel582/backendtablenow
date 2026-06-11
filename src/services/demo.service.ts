import { v4 as uuidv4 } from 'uuid';
import supabase from '../config/supabase';
import logger from '../lib/logger';
import { syncAvailabilityRules } from './availability.service';
import {
    DEFAULT_SERVICE_TYPES,
    capacityFromOpeningHours,
    extractServiceTypesFromOpeningHours,
} from '../lib/restaurant.utils';

const DEMO_OPENING_HOURS = [
    {
        enabled: true,
        services: [
            { name: 'Déjeuner', start: '12:00', end: '14:30', covers: 60 },
            { name: 'Dîner', start: '19:00', end: '22:30', covers: 80 },
        ],
    },
    {
        enabled: true,
        services: [
            { name: 'Déjeuner', start: '12:00', end: '14:30', covers: 60 },
            { name: 'Dîner', start: '19:00', end: '22:30', covers: 80 },
        ],
    },
    {
        enabled: true,
        services: [
            { name: 'Déjeuner', start: '12:00', end: '14:30', covers: 60 },
            { name: 'Dîner', start: '19:00', end: '22:30', covers: 80 },
        ],
    },
    {
        enabled: true,
        services: [
            { name: 'Déjeuner', start: '12:00', end: '14:30', covers: 60 },
            { name: 'Dîner', start: '19:00', end: '22:30', covers: 80 },
        ],
    },
    {
        enabled: true,
        services: [
            { name: 'Déjeuner', start: '12:00', end: '14:30', covers: 60 },
            { name: 'Brunch', start: '10:00', end: '14:00', covers: 40 },
            { name: 'Dîner', start: '19:00', end: '23:00', covers: 80 },
        ],
    },
    {
        enabled: true,
        services: [
            { name: 'Brunch', start: '10:00', end: '14:00', covers: 50 },
            { name: 'Dîner', start: '19:00', end: '23:00', covers: 80 },
        ],
    },
    { enabled: false, services: [] },
];

function addDays(base: Date, days: number): string {
    const d = new Date(base);
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
}

function addMinutesToLocalISO(date: string, time: string, mins: number): string {
    const d = new Date(`${date}T${time}:00Z`);
    d.setUTCMinutes(d.getUTCMinutes() + mins);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${
        p(d.getUTCDate())
    }T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00`;
}

export async function seedDemoData(restaurantId: string, reset = false): Promise<Record<string, number>> {
    const { data: restaurant, error } = await supabase
        .from('restaurants')
        .select('id, services, opening_hours')
        .eq('id', restaurantId)
        .single();

    if (error || !restaurant) {
        throw new Error('Restaurant not found');
    }

    if (reset) {
        await supabase.from('bookings').delete().eq('restaurant_id', restaurantId);
        await supabase.from('call_logs').delete().eq('restaurant_id', restaurantId);
    }

    const serviceTypes = extractServiceTypesFromOpeningHours(
        DEMO_OPENING_HOURS,
        (restaurant.services as string[]) || DEFAULT_SERVICE_TYPES
    );
    const capacity = capacityFromOpeningHours(DEMO_OPENING_HOURS, 80);

    await supabase
        .from('restaurants')
        .update({
            opening_hours: DEMO_OPENING_HOURS,
            services: serviceTypes,
            capacity,
            max_covers: capacity,
        })
        .eq('id', restaurantId);

    await syncAvailabilityRules(restaurantId);

    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const tomorrowStr = addDays(today, 1);

    const bookings = [
        {
            id: uuidv4(),
            restaurant_id: restaurantId,
            guest_name: 'Marie Dupont',
            guest_email: 'marie.dupont@example.com',
            guest_phone: '+33601020304',
            booking_date: todayStr,
            booking_time: '19:30',
            booked_for: addMinutesToLocalISO(todayStr, '19:30', 0),
            party_size: 4,
            status: 'confirmed',
            source: 'phone',
            confirmation_number: `DEMO-CNF-001`,
        },
        {
            id: uuidv4(),
            restaurant_id: restaurantId,
            guest_name: 'Jean Martin',
            guest_email: 'jean.martin@example.com',
            guest_phone: '+33605060708',
            booking_date: tomorrowStr,
            booking_time: '12:30',
            booked_for: addMinutesToLocalISO(tomorrowStr, '12:30', 0),
            party_size: 2,
            status: 'confirmed',
            source: 'phone',
            confirmation_number: `DEMO-CNF-002`,
        },
        {
            id: uuidv4(),
            restaurant_id: restaurantId,
            guest_name: 'Sophie Bernard',
            guest_email: 'sophie.bernard@example.com',
            guest_phone: '+33609101112',
            booking_date: todayStr,
            booking_time: '20:00',
            booked_for: addMinutesToLocalISO(todayStr, '20:00', 0),
            party_size: 6,
            status: 'cancelled',
            source: 'phone',
            confirmation_number: `DEMO-CNF-003`,
        },
    ];

    const { error: bookingErr } = await supabase.from('bookings').insert(bookings);
    if (bookingErr) {
        logger.error({ err: bookingErr.message }, 'Demo seed: bookings insert failed');
        throw bookingErr;
    }

    const calls = [
        {
            id: uuidv4(),
            restaurant_id: restaurantId,
            call_id: `DEMO-CALL-001`,
            caller_number: '+33601020304',
            duration: 142,
            status: 'completed',
            reservation_booked: true,
            transcript: 'Demo: réservation pour 4 personnes ce soir à 19h30.',
            created_at: new Date().toISOString(),
        },
        {
            id: uuidv4(),
            restaurant_id: restaurantId,
            call_id: `DEMO-CALL-002`,
            caller_number: '+33613141516',
            duration: 38,
            status: 'completed',
            reservation_booked: false,
            transcript: 'Demo: demande d\'information — pas de réservation.',
            created_at: new Date(Date.now() - 3600000).toISOString(),
        },
        {
            id: uuidv4(),
            restaurant_id: restaurantId,
            call_id: `DEMO-CALL-003`,
            caller_number: '+33617181920',
            duration: 12,
            status: 'missed',
            reservation_booked: false,
            transcript: null,
            created_at: new Date(Date.now() - 7200000).toISOString(),
        },
    ];

    const { error: callErr } = await supabase.from('call_logs').insert(calls);
    if (callErr) {
        logger.error({ err: callErr.message }, 'Demo seed: call_logs insert failed');
        throw callErr;
    }

    logger.info({ restaurantId, reset }, 'Demo data seeded');

    return {
        bookings: bookings.length,
        calls: calls.length,
        service_types: serviceTypes.length,
        capacity,
    };
}

export default { seedDemoData };
