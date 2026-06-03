/**
 * Timezone helpers — DST-safe, dependency-free.
 *
 * The booking engine and calendars deal with *wall-clock* times in a restaurant's
 * IANA timezone (e.g. "19:00 Europe/Paris"). Storing/sending those naively (treating
 * them as UTC) is the root cause of the 1–2h drift on calendar events. These helpers
 * convert a wall-clock date+time in a given timezone to the correct UTC instant.
 */

/**
 * Offset (in ms) of `timeZone` at the absolute instant `date`, i.e. (localTime - UTC).
 * Europe/Paris in summer (CEST) returns +7200000; in winter (CET) returns +3600000.
 */
function tzOffsetMs(date: Date, timeZone: string): number {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    });

    const parts: Record<string, string> = {};
    for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;

    let hour = Number(parts.hour);
    if (hour === 24) hour = 0; // some engines emit "24" for midnight

    const asUtc = Date.UTC(
        Number(parts.year), Number(parts.month) - 1, Number(parts.day),
        hour, Number(parts.minute), Number(parts.second),
    );

    return asUtc - date.getTime();
}

/**
 * Convert a wall-clock date/time in `timeZone` to the correct UTC instant.
 *
 * @param dateStr "YYYY-MM-DD"
 * @param timeStr "HH:MM" or "HH:MM:SS"
 * @param timeZone IANA zone, e.g. "Europe/Paris"
 */
export function zonedWallTimeToUtc(dateStr: string, timeStr: string, timeZone: string): Date {
    const [y, m, d] = dateStr.split('-').map(Number);
    const [hh = 0, mm = 0, ss = 0] = (timeStr || '').split(':').map(Number);

    // Naive guess: treat the wall-clock as if it were UTC.
    const utcGuess = Date.UTC(y, (m || 1) - 1, d || 1, hh, mm, ss);

    // Correct by the zone offset at that instant, then re-check once to handle DST edges.
    const offset1 = tzOffsetMs(new Date(utcGuess), timeZone);
    let result = utcGuess - offset1;
    const offset2 = tzOffsetMs(new Date(result), timeZone);
    if (offset2 !== offset1) result = utcGuess - offset2;

    return new Date(result);
}
