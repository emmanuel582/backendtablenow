type UiService = { name?: string; start?: string; end?: string; covers?: number };
type UiDay = { enabled?: boolean; services?: UiService[] };

export const DEFAULT_SERVICE_TYPES = ['Déjeuner', 'Dîner', 'Brunch', 'Apéritif', 'Service spécial'];

export function isRestaurantProfileComplete(restaurant: Record<string, unknown> | null | undefined): boolean {
    if (!restaurant) return false;
    return !!(
        restaurant.name &&
        restaurant.owner_name &&
        restaurant.address &&
        restaurant.phone
    );
}

/** Capacité journalière max = somme des couverts des services du jour le plus chargé. */
export function capacityFromOpeningHours(
    openingHours: UiDay[] | null | undefined,
    fallback = 50
): number {
    if (!Array.isArray(openingHours) || openingHours.length === 0) return fallback;

    let maxDayTotal = 0;
    for (const day of openingHours) {
        if (!day?.enabled || !Array.isArray(day.services)) continue;
        const dayTotal = day.services.reduce(
            (sum, svc) => sum + (Number(svc?.covers) > 0 ? Number(svc.covers) : 0),
            0
        );
        maxDayTotal = Math.max(maxDayTotal, dayTotal);
    }
    return maxDayTotal || fallback;
}

/** Capacité pour un jour donné (index UI 0=Lundi … 6=Dimanche). */
export function capacityForDayIndex(
    openingHours: UiDay[] | null | undefined,
    dayIndex: number,
    fallback = 50
): number {
    if (!Array.isArray(openingHours) || !openingHours[dayIndex]?.enabled) return fallback;
    const services = openingHours[dayIndex].services;
    if (!Array.isArray(services) || services.length === 0) return fallback;
    const total = services.reduce(
        (sum, svc) => sum + (Number(svc?.covers) > 0 ? Number(svc.covers) : 0),
        0
    );
    return total || fallback;
}

/** Index UI (0=Lundi) pour la date courante. */
export function uiDayIndexForDate(date: Date = new Date()): number {
    const jsDow = date.getDay(); // 0=Sun … 6=Sat
    return jsDow === 0 ? 6 : jsDow - 1;
}

export function extractServiceTypesFromOpeningHours(
    openingHours: UiDay[] | null | undefined,
    existing: string[] | null | undefined
): string[] {
    const fromHours = new Set<string>();
    if (Array.isArray(openingHours)) {
        for (const day of openingHours) {
            if (!Array.isArray(day?.services)) continue;
            for (const svc of day.services) {
                const name = typeof svc?.name === 'string' ? svc.name.trim() : '';
                if (name) fromHours.add(name);
            }
        }
    }

    const merged = [...(existing || DEFAULT_SERVICE_TYPES)];
    for (const name of fromHours) {
        if (!merged.includes(name)) merged.push(name);
    }
    return merged;
}
