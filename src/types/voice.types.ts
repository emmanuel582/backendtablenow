// ============================================
// Voice Core Types — Voice agent reliability layer
// Provider-agnostic types for the TableNow Voice Core
// ============================================

// ── Intent Classification ────────────────────────────────────────────────────

export type VoiceIntent =
  | 'new_booking'
  | 'modify_booking'
  | 'cancel_booking'
  | 'question_hours'
  | 'question_address'
  | 'question_menu'
  | 'question_allergens'
  | 'private_event'
  | 'speak_to_human'
  | 'out_of_scope'
  | 'unknown';

// ── Slot State Machine ───────────────────────────────────────────────────────

export type VoiceSlotStatus = 'missing' | 'inferred' | 'confirmed';

export type VoiceSlotSource =
  | 'user_input'
  | 'caller_id'
  | 'system_default'
  | 'unknown';

export interface VoiceSlotState<T> {
  value: T | null;
  status: VoiceSlotStatus;
  source: VoiceSlotSource;
}

export interface BookingSlots {
  first_name: VoiceSlotState<string>;
  last_name: VoiceSlotState<string>;
  phone: VoiceSlotState<string>;
  guest_count: VoiceSlotState<number>;
  date: VoiceSlotState<string>;
  time: VoiceSlotState<string>;
  email: VoiceSlotState<string>;
  special_request: VoiceSlotState<string>;
}

export type CriticalBookingField =
  | 'first_name'
  | 'last_name'
  | 'phone'
  | 'guest_count'
  | 'date'
  | 'time';

export const CRITICAL_BOOKING_FIELDS: readonly CriticalBookingField[] = [
  'first_name',
  'last_name',
  'phone',
  'guest_count',
  'date',
  'time',
] as const;

// ── Session State ────────────────────────────────────────────────────────────

export type ConfirmationStatus =
  | 'not_required'
  | 'pending'
  | 'confirmed'
  | 'rejected';

export type BackendActionStatus =
  | 'idle'
  | 'in_progress'
  | 'success'
  | 'failure';

export interface VoiceSessionState {
  call_id: string;
  restaurant_id: string;
  intent: VoiceIntent;
  language: 'fr' | 'en';
  slots: Partial<BookingSlots>;
  confirmation_status: ConfirmationStatus;
  backend_action_status: BackendActionStatus;
}

// ── Reliability Decisions ────────────────────────────────────────────────────

export type VoiceAction =
  | {
      type: 'ask_clarification';
      field: CriticalBookingField | 'intent';
      message: string;
    }
  | {
      type: 'ask_confirmation';
      summary: string;
    }
  | {
      type: 'proceed_to_booking';
    }
  | {
      type: 'fallback_human';
      reason: string;
    }
  | {
      type: 'answer_question';
      intent: VoiceIntent;
    };

export interface VoiceReliabilityDecision {
  action: VoiceAction;
  blocking_reasons: readonly string[];
  missing_critical: readonly CriticalBookingField[];
  inferred_critical: readonly CriticalBookingField[];
  can_proceed: boolean;
}

// ── Restaurant Context ───────────────────────────────────────────────────────

export interface ResolvedVoiceRestaurant {
  id: string;
  name: string;
  slug: string;
  address: string;
  phone: string;
  opening_hours: unknown;
  language: 'fr' | 'en';
  google_calendar_tokens?: string | null;
}

export interface VoiceAssistantContext {
  restaurant: ResolvedVoiceRestaurant;
  variables: Readonly<Record<string, string>>;
  language: 'fr' | 'en';
}

// ── Booking Orchestration Results ────────────────────────────────────────────

export type BookingOrchestrationResult =
  | {
      status: 'success';
      booking_id: string;
      message: string;
    }
  | {
      status: 'unavailable';
      alternatives: readonly string[];
      message: string;
    }
  | {
      status: 'failed';
      reason: string;
      message: string;
    }
  | {
      status: 'needs_clarification';
      missing_fields: readonly CriticalBookingField[];
      message: string;
    }
  | {
      status: 'awaiting_confirmation';
      summary: string;
      message: string;
    };

// ── Provider Payload ─────────────────────────────────────────────────────────

export type VoiceProviderEventType =
  | 'call.started'
  | 'call.ended'
  | 'tool.invoked'
  | 'message'
  | 'end_of_call_report'
  | 'unknown';

export interface VoiceToolCall {
  tool_call_id: string;
  name: string;
  parameters: Readonly<Record<string, unknown>>;
}

export interface VoiceProviderPayload {
  call_id: string;
  caller_phone: string | null;
  called_phone: string | null;
  event_type: VoiceProviderEventType;
  transcript: string | null;
  tool_call: VoiceToolCall | null;
  raw: Readonly<Record<string, unknown>>;
}

// ── Call Logging ─────────────────────────────────────────────────────────────

export type CallLogEventType =
  | 'call_started'
  | 'call_ended'
  | 'intent_detected'
  | 'slot_filled'
  | 'clarification_requested'
  | 'confirmation_requested'
  | 'confirmation_received'
  | 'booking_attempted'
  | 'booking_succeeded'
  | 'booking_failed'
  | 'fallback_to_human'
  | 'availability_checked'
  | 'reliability_gate_passed'
  | 'reliability_gate_blocked'
  | 'provider_error'
  | 'backend_error';

export interface CallLogEvent {
  call_id: string;
  restaurant_id: string | null;
  event_type: CallLogEventType;
  payload: Readonly<Record<string, unknown>>;
  timestamp: string;
}

// ── Booking Events ──────────────────────────────────────────────────────────

export type BookingEventType =
  | 'booking_created'
  | 'booking_confirmed'
  | 'booking_cancelled'
  | 'booking_modified'
  | 'booking_failed'
  | 'availability_checked'
  | 'customer_upserted';

export interface BookingEvent {
  booking_id?: string | null;
  restaurant_id: string;
  event_type: BookingEventType;
  source: 'manual' | 'phone' | 'web' | 'api';
  payload: Readonly<Record<string, unknown>>;
  timestamp: string;
  call_id?: string | null;
}

// ── Reliability Events ──────────────────────────────────────────────────────

export type ReliabilityGate =
  | 'intent_classification'
  | 'critical_field_missing'
  | 'critical_field_inferred'
  | 'final_confirmation_missing'
  | 'availability_check'
  | 'backend_guard';

export interface ReliabilityEvent {
  call_id: string;
  restaurant_id: string;
  event_type: 'gate_passed' | 'gate_blocked';
  gate: ReliabilityGate;
  payload: Readonly<Record<string, unknown>>;
  timestamp: string;
}
