/**
 * Booking Types
 * Strict typing for booking-related operations
 */

import { z } from 'zod';

// ─── Enums ────────────────────────────────────────────────────────────────

export type BookingStatus = 'confirmed' | 'cancelled' | 'completed' | 'no_show';
export type BookingSource = 'dashboard' | 'vapi' | 'bcc' | 'whatsapp';
export type Language = 'fr' | 'en';

// ─── Core Booking Types ───────────────────────────────────────────────────

export interface CreateBookingInput {
    restaurant_id: string;
    guest_name: string;
    guest_email?: string;
    guest_phone?: string;
    date: string; // YYYY-MM-DD
    time: string; // HH:MM
    covers: number;
    special_requests?: string;
    source: BookingSource;
    language?: Language;
    idempotency_key?: string;
}

export interface CreateBookingResult {
    id: string;
    restaurant_id: string;
    guest_name: string;
    guest_email: string | null;
    guest_phone: string | null;
    date: string;
    time: string;
    covers: number;
    status: BookingStatus;
    source: BookingSource;
    special_requests: string | null;
    language: Language;
    google_calendar_event_id: string | null;
    confirmation_email_sent: boolean;
    bcc_email_sent: boolean;
    created_at: string;
}

export interface UpdateBookingInput {
    status?: BookingStatus;
    guest_name?: string;
    guest_email?: string;
    guest_phone?: string;
    date?: string;
    time?: string;
    covers?: number;
    special_requests?: string;
}

export interface BookingQuery {
    status?: BookingStatus;
    date?: string;
    limit: number;
    offset: number;
}

export interface CheckAvailabilityInput {
    restaurant_id: string; // UUID or slug
    date: string; // YYYY-MM-DD
    time: string; // HH:MM
    covers: number;
}

export interface AvailabilitySlot {
    slot_time: string;
    available: boolean;
    remaining: number;
}

export interface CheckAvailabilityResult {
    available: boolean;
    slots: AvailabilitySlot[];
}

// ─── Reservation Info (internal use) ───────────────────────────────────────

export interface ReservationInfo {
    restaurant_id: string;
    first_name: string;
    last_name: string;
    phone: string;
    email: string | null;
    covers: number;
    occasion: string | null;
    date: string;
    time: string;
    language: Language;
    booking_id: string;
}

// ─── Database Models ──────────────────────────────────────────────────────

export interface BookingRecord {
    id: string;
    restaurant_id: string;
    customer_id: string | null;
    booked_for: string; // ISO timestamp
    covers: number;
    special_requests: string | null;
    source: BookingSource;
    status: BookingStatus;
    guest_language: Language;
    google_calendar_event_id: string | null;
    confirmation_email_sent: boolean;
    bcc_email_sent: boolean;
    created_at: string;
    updated_at: string;
}

export interface CustomerRecord {
    id: string;
    restaurant_id: string;
    phone: string;
    name: string;
    email: string | null;
    created_at: string;
    updated_at: string;
}
