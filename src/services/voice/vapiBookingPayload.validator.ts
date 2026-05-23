// ─────────────────────────────────────────────────────────────────────────────
// Defensive validator for VAPI POST /create-booking payloads.
//
// VAPI's webhook is expected to fire only after fields are collected, but we
// MUST NOT trust that contract blindly. This validator enforces that every
// critical slot has a syntactically-valid value before we synthesize a
// VoiceSessionState with status='confirmed'. Without this, a malformed or
// premature VAPI call could promote raw input straight to "confirmed" and
// bypass the conversation-level reliability guards.
// ─────────────────────────────────────────────────────────────────────────────

export interface RawBookingPayload {
    restaurantId: unknown;
    date: unknown;
    time: unknown;
    covers: unknown;
    firstName: unknown;
    lastName: unknown;
    guestPhone: unknown;
    guestEmail?: unknown;
}

export interface ValidBookingPayload {
    restaurantId: string;
    date: string;
    time: string;
    covers: number;
    firstName: string;
    lastName: string;
    guestPhone: string;
    guestEmail: string | null;
}

export type ValidationResult =
    | { valid: true; data: ValidBookingPayload }
    | { valid: false; missing: string[]; invalid: string[]; message: string };

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const TIME_REGEX = /^([01]?\d|2[0-3]):[0-5]\d$/;
const MIN_PHONE_DIGITS = 6;
const MAX_PHONE_DIGITS = 20;
const MIN_COVERS = 1;
const MAX_COVERS = 50;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isNonEmptyString(v: unknown): v is string {
    return typeof v === 'string' && v.trim().length > 0;
}

function isValidDate(v: unknown): v is string {
    if (!isNonEmptyString(v) || !DATE_REGEX.test(v)) return false;
    const parsed = new Date(`${v}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) return false;
    // Round-trip check rejects "2026-02-30"
    return parsed.toISOString().slice(0, 10) === v;
}

function isValidTime(v: unknown): v is string {
    return isNonEmptyString(v) && TIME_REGEX.test(v);
}

function isValidCovers(v: unknown): v is number {
    const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
    return Number.isInteger(n) && n >= MIN_COVERS && n <= MAX_COVERS;
}

function isValidPhone(v: unknown): v is string {
    if (!isNonEmptyString(v)) return false;
    const digits = v.replace(/\D/g, '');
    return digits.length >= MIN_PHONE_DIGITS && digits.length <= MAX_PHONE_DIGITS;
}

function isValidName(v: unknown): v is string {
    return isNonEmptyString(v) && v.trim().length >= 1 && v.trim().length <= 80;
}

function isValidEmail(v: unknown): v is string {
    return isNonEmptyString(v) && EMAIL_REGEX.test(v.trim());
}

export function validateBookingPayload(input: RawBookingPayload): ValidationResult {
    const missing: string[] = [];
    const invalid: string[] = [];

    // restaurant_id: required, non-empty string (slug or UUID)
    if (!isNonEmptyString(input.restaurantId)) {
        if (input.restaurantId == null || input.restaurantId === '') missing.push('restaurant_id');
        else invalid.push('restaurant_id');
    }

    // date: required, YYYY-MM-DD and actually valid
    if (input.date == null || input.date === '') missing.push('date');
    else if (!isValidDate(input.date)) invalid.push('date');

    // time: required, HH:MM 24-hour
    if (input.time == null || input.time === '') missing.push('time');
    else if (!isValidTime(input.time)) invalid.push('time');

    // covers: required, integer in [1, 50]
    if (input.covers == null || input.covers === '' || Number.isNaN(input.covers as number)) {
        missing.push('covers');
    } else if (!isValidCovers(input.covers)) {
        invalid.push('covers');
    }

    // first_name / last_name: required, non-empty after trim
    if (input.firstName == null || input.firstName === '') missing.push('first_name');
    else if (!isValidName(input.firstName)) invalid.push('first_name');

    if (input.lastName == null || input.lastName === '') missing.push('last_name');
    else if (!isValidName(input.lastName)) invalid.push('last_name');

    // phone: required, contains at least MIN_PHONE_DIGITS digits
    if (input.guestPhone == null || input.guestPhone === '') missing.push('phone');
    else if (!isValidPhone(input.guestPhone)) invalid.push('phone');

    // email: optional, but if present must be syntactically valid
    let normalizedEmail: string | null = null;
    if (input.guestEmail != null && input.guestEmail !== '') {
        if (!isValidEmail(input.guestEmail)) {
            invalid.push('email');
        } else {
            normalizedEmail = (input.guestEmail as string).trim().toLowerCase();
        }
    }

    if (missing.length > 0 || invalid.length > 0) {
        const parts: string[] = [];
        if (missing.length > 0) parts.push(`champs manquants: ${missing.join(', ')}`);
        if (invalid.length > 0) parts.push(`champs invalides: ${invalid.join(', ')}`);
        return {
            valid: false,
            missing,
            invalid,
            message: `Impossible de créer la réservation — ${parts.join(' ; ')}.`,
        };
    }

    return {
        valid: true,
        data: {
            restaurantId: (input.restaurantId as string).trim(),
            date: (input.date as string).trim(),
            time: (input.time as string).trim(),
            covers: typeof input.covers === 'number'
                ? input.covers
                : parseInt(String(input.covers), 10),
            firstName: (input.firstName as string).trim(),
            lastName: (input.lastName as string).trim(),
            guestPhone: (input.guestPhone as string).trim(),
            guestEmail: normalizedEmail,
        },
    };
}

export default { validateBookingPayload };
