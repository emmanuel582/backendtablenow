import supabase from '../config/supabase';
import logger from '../lib/logger';

// Granularité des créneaux (minutes) générés pour get_available_slots.
// Fine (15 min) pour que les heures rondes/quarts demandées par l'IA matchent.
const SLOT_GRANULARITY_MIN = 15;
const DEFAULT_TZ = 'Europe/Paris';

type UiService = { name?: string; start?: string; end?: string; covers?: number };
type UiDay = { enabled?: boolean; services?: UiService[] };

function toHHMM(t?: string): string | null {
    if (!t || typeof t !== 'string') return null;
    const m = t.match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    return `${m[1].padStart(2, '0')}:${m[2]}`;
}

/**
 * Pont CRUCIAL entre l'UI "Horaires & Services" (restaurants.opening_hours, format
 * [{enabled, services:[{name,start,end,covers}]}] × 7 jours, index 0=Lundi…6=Dimanche)
 * et le moteur de créneaux get_available_slots (table availability_rules).
 *
 * Source de vérité : les "disponibilités réelles" vivent dans availability_rules (base
 * TableNow), DÉRIVÉES des horaires affichés. opening_hours seul ne suffit pas au moteur.
 * Sans cette synchro, availability_rules reste vide -> 0 créneau -> l'IA ne peut jamais
 * réserver. On régénère les règles à chaque sauvegarde des horaires.
 *
 * Mapping jour : EXTRACT(dow) Postgres = 0=Dimanche…6=Samedi ; UI 0=Lundi -> dow=(i+1)%7.
 */
export async function syncAvailabilityRules(restaurantId: string): Promise<number> {
    const { data: restaurant, error } = await supabase
        .from('restaurants')
        .select('opening_hours, capacity, max_covers, timezone')
        .eq('id', restaurantId)
        .single();

    if (error || !restaurant) {
        logger.warn({ restaurantId, err: error?.message }, 'syncAvailabilityRules: restaurant introuvable');
        return 0;
    }

    // S'assurer que le fuseau est défini (get_available_slots l'utilise pour AT TIME ZONE)
    if (!restaurant.timezone) {
        await supabase.from('restaurants').update({ timezone: DEFAULT_TZ }).eq('id', restaurantId);
    }

    const oh = restaurant.opening_hours as UiDay[] | null;
    if (!Array.isArray(oh)) {
        logger.info({ restaurantId }, 'syncAvailabilityRules: opening_hours non défini/format inattendu — aucune règle générée');
        // On vide quand même pour rester cohérent avec l'UI.
        await supabase.from('availability_rules').delete().eq('restaurant_id', restaurantId);
        return 0;
    }

    const fallbackCovers = (restaurant.max_covers as number) || (restaurant.capacity as number) || 50;

    const rows: Array<Record<string, unknown>> = [];
    oh.forEach((day, i) => {
        if (!day?.enabled || !Array.isArray(day.services)) return;
        const dow = (i + 1) % 7; // UI 0=Lundi -> dow 1 ; UI 6=Dimanche -> dow 0
        for (const svc of day.services) {
            const start = toHHMM(svc?.start);
            const end = toHHMM(svc?.end);
            if (!start || !end || start >= end) continue;
            rows.push({
                restaurant_id: restaurantId,
                day_of_week: dow,
                slot_start: start,
                slot_end: end,
                slot_duration_min: SLOT_GRANULARITY_MIN,
                max_covers_per_slot: Number(svc?.covers) > 0 ? Number(svc.covers) : fallbackCovers,
                is_active: true,
            });
        }
    });

    // Régénération atomique : on supprime puis réinsère.
    const { error: delErr } = await supabase.from('availability_rules').delete().eq('restaurant_id', restaurantId);
    if (delErr) {
        logger.error({ restaurantId, err: delErr.message }, 'syncAvailabilityRules: suppression échouée');
        throw delErr;
    }

    if (rows.length > 0) {
        const { error: insErr } = await supabase.from('availability_rules').insert(rows);
        if (insErr) {
            logger.error({ restaurantId, err: insErr.message }, 'syncAvailabilityRules: insertion échouée');
            throw insErr;
        }
    }

    // Cohérence : alimenter restaurant_settings (utilisé par le moteur de réservation atomique).
    await supabase
        .from('restaurant_settings')
        .upsert(
            {
                restaurant_id: restaurantId,
                tz: restaurant.timezone || DEFAULT_TZ,
                slot_interval: SLOT_GRANULARITY_MIN,
                max_covers: fallbackCovers,
            },
            { onConflict: 'restaurant_id' }
        );

    logger.info({ restaurantId, rules: rows.length }, '✅ availability_rules régénérées depuis opening_hours');
    return rows.length;
}

export default { syncAvailabilityRules };
