/**
 * Calendar Integration Types
 * Strict typing for Google Calendar operations
 */

// ─── Enums ────────────────────────────────────────────────────────────────

export type CalendarProvider = 'google';

// ─── Events ───────────────────────────────────────────────────────────────

export interface CalendarEvent {
    summary: string;
    description?: string;
    start: Date;
    end: Date;
    attendees?: string[]; // email addresses
    colorId?: string;
}

export interface CalendarSyncEvent {
    id: string;
    booking_id: string;
    provider: CalendarProvider;
    external_event_id: string;
    external_event_url?: string;
    synced_at: string;
    last_updated: string;
    status: 'active' | 'cancelled' | 'failed';
}

// ─── Callback Data (from Google OAuth) ────────────────────────────────────

export interface CalendarCallbackData {
    code?: string;
    state?: string;
    error?: string;
    error_description?: string;
}

// ─── OAuth Tokens ─────────────────────────────────────────────────────────

export interface CalendarOAuthTokens {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expiry_date: number;
    scope: string;
}

// ─── Sync Status ──────────────────────────────────────────────────────────

export interface CalendarSyncStatus {
    restaurant_id: string;
    provider: CalendarProvider;
    last_sync: string;
    last_sync_status: 'success' | 'failed' | 'pending';
    next_sync: string;
    synced_events_count: number;
    failed_events_count: number;
}

// ─── Calendar Operations Result ───────────────────────────────────────────

export interface CreateEventResult {
    id?: string;
    url?: string;
    success: boolean;
    error?: string;
}

export interface SyncResult {
    success: boolean;
    synced_count: number;
    failed_count: number;
    errors?: string[];
}
