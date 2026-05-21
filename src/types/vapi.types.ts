/**
 * VAPI Webhook & Event Types
 * Strict typing for Vapi integration
 */

// ─── VAPI Events ──────────────────────────────────────────────────────────

export type VapiEvent = 'call-started' | 'call-ended' | 'booking-requested' | 'message-sent';

export interface VapiWebhookPayload {
    event: VapiEvent;
    call?: VapiCallData;
    message?: VapiMessageData;
}

// ─── Call Data ────────────────────────────────────────────────────────────

export interface VapiCallData {
    id: string;
    assistant?: {
        id: string;
        name: string;
    };
    customer?: {
        number?: string;
    };
    started_at?: string;
    ended_at?: string;
    duration?: number;
    status?: 'active' | 'ended' | 'failed';
    messages?: VapiMessage[];
    tool_calls?: VapiToolCall[];
}

export interface VapiMessage {
    role: 'assistant' | 'user';
    message: string;
    timestamp?: string;
}

// ─── Tool Calls (for booking requests) ────────────────────────────────────

export interface VapiToolCall {
    id?: string;
    type?: 'function';
    function?: {
        name: string;
        arguments: Record<string, unknown> | string;
    };
    // Legacy format support
    name?: string;
    parameters?: Record<string, unknown>;
}

export interface CreateBookingRequest {
    restaurant_id?: string;
    guest_name?: string;
    guest_email?: string;
    guest_phone?: string;
    date?: string;
    time?: string;
    covers?: number;
    special_requests?: string;
}

// ─── Message Data ─────────────────────────────────────────────────────────

export interface VapiMessageData {
    id: string;
    call_id: string;
    type: 'sms' | 'whatsapp';
    from?: string;
    to?: string;
    content: string;
    timestamp?: string;
}

// ─── Webhook Response ─────────────────────────────────────────────────────

export interface VapiWebhookResponse {
    success: boolean;
    message?: string;
    error?: string;
    agent_script?: string;
}

// ─── Call Status for Tracking ─────────────────────────────────────────────

export interface VapiCallStatus {
    call_id: string;
    status: 'active' | 'ended' | 'failed';
    booking_attempted: boolean;
    booking_created?: string; // booking ID if created
    error?: string;
}
