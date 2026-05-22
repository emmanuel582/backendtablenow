/**
 * Restaurant Types
 * Strict typing for restaurant data and settings
 */

import { Language } from './booking.types';

// ─── Settings ─────────────────────────────────────────────────────────────

export interface RestaurantHours {
    [day: string]: {
        open: string; // HH:MM
        close: string; // HH:MM
        closed?: boolean;
    };
}

export interface RestaurantSettings {
    hours?: RestaurantHours;
    timezone?: string;
    language?: Language;
    booking_buffer_minutes?: number;
    max_party_size?: number;
    min_party_size?: number;
    advance_booking_days?: number;
}

// ─── Core Restaurant Type ─────────────────────────────────────────────────

export interface Restaurant {
    id: string;
    name: string;
    slug: string;
    cuisine_type?: string;
    phone?: string;
    email?: string;
    address?: string;
    city?: string;
    postal_code?: string;
    country?: string;
    description?: string;
    website?: string;
    image_url?: string;
    logo_url?: string;
    settings: RestaurantSettings;
    language: Language;
    timezone: string;
    created_at: string;
    updated_at: string;
}

// ─── Integration Data ─────────────────────────────────────────────────────

export interface RestaurantIntegrations {
    id: string;
    restaurant_id: string;
    google_calendar_tokens?: GoogleCalendarTokens;
    google_calendar_tokens_raw?: string; // Raw JSON from DB
    pms_email?: string;
    pms_type?: string; // 'opera', 'micros', 'custom'
    twilio_phone_sid?: string;
    vapi_assistant_id?: string;
    stripe_connect_id?: string;
    hubspot_api_key?: string;
    created_at: string;
    updated_at: string;
}

// ─── Google Calendar ──────────────────────────────────────────────────────

export interface GoogleCalendarTokens {
    access_token: string;
    refresh_token: string;
    expiry_date: number;
    token_type: string;
    scope: string;
}

// ─── Database Record ──────────────────────────────────────────────────────

export interface RestaurantRecord {
    id: string;
    user_id: string;
    name: string;
    slug: string;
    cuisine_type?: string;
    phone?: string;
    email?: string;
    address?: string;
    city?: string;
    postal_code?: string;
    country?: string;
    description?: string;
    website?: string;
    image_url?: string;
    logo_url?: string;
    settings?: RestaurantSettings | string;
    language: Language;
    timezone: string;
    google_calendar_tokens?: string; // JSON string in DB
    pms_email?: string;
    pms_type?: string;
    twilio_phone_sid?: string;
    vapi_assistant_id?: string;
    stripe_connect_id?: string;
    hubspot_api_key?: string;
    created_at: string;
    updated_at: string;
}
