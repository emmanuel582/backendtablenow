// ============================================
// Call Logging Service — Voice Core
//
// Persists call lifecycle, intent detection, slot updates,
// confirmation gates and booking outcomes.
//
// Two surfaces:
//   - call_logs table (durable per-call summary)
//   - structured logger events (correlated by call_id) for observability
// ============================================

import supabase from '../../config/supabase';
import logger from '../../lib/logger';
import type {
  CallLogEvent,
  CallLogEventType,
} from '../../types/voice.types';

interface CallStartedInput {
  call_id: string;
  caller_phone: string | null;
  restaurant_id: string | null;
}

interface CallEndedInput {
  call_id: string;
  duration_seconds: number;
  transcript: string | null;
  status: 'completed' | 'failed' | 'missed';
}

class CallLoggingService {
  async logCallStarted(input: CallStartedInput): Promise<void> {
    try {
      await supabase
        .from('call_logs')
        .insert({
          external_call_id: input.call_id,
          caller_number: input.caller_phone,
          restaurant_id: input.restaurant_id,
          started_at: new Date().toISOString(),
          status: 'in_progress',
        });

      this.emit({
        call_id: input.call_id,
        restaurant_id: input.restaurant_id,
        event_type: 'call_started',
        payload: { caller_phone: input.caller_phone ? 'redacted' : null },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      logger.error(
        { action: 'log_call_started', call_id: input.call_id, error: msg },
        'Failed to persist call started'
      );
    }
  }

  async logCallEnded(input: CallEndedInput): Promise<void> {
    try {
      await supabase
        .from('call_logs')
        .update({
          status: input.status,
          ended_at: new Date().toISOString(),
          duration: Math.max(0, Math.round(input.duration_seconds)),
          transcript: input.transcript,
        })
        .eq('external_call_id', input.call_id);

      this.emit({
        call_id: input.call_id,
        restaurant_id: null,
        event_type: 'call_ended',
        payload: {
          status: input.status,
          duration_seconds: input.duration_seconds,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      logger.error(
        { action: 'log_call_ended', call_id: input.call_id, error: msg },
        'Failed to persist call ended'
      );
    }
  }

  async linkBooking(call_id: string, booking_id: string): Promise<void> {
    try {
      await supabase
        .from('call_logs')
        .update({ booking_id })
        .eq('external_call_id', call_id);

      this.emit({
        call_id,
        restaurant_id: null,
        event_type: 'booking_succeeded',
        payload: { booking_id },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      logger.error(
        { action: 'link_booking', call_id, booking_id, error: msg },
        'Failed to link booking to call'
      );
    }
  }

  // Pure observability surface — never throws
  emit(event: CallLogEvent): void {
    logger.info(
      {
        action: 'voice_event',
        event_type: event.event_type,
        call_id: event.call_id,
        restaurant_id: event.restaurant_id,
        payload: event.payload,
      },
      `voice.${event.event_type}`
    );
  }

  emitTyped(
    call_id: string,
    restaurant_id: string | null,
    event_type: CallLogEventType,
    payload: Record<string, unknown>
  ): void {
    this.emit({
      call_id,
      restaurant_id,
      event_type,
      payload,
      timestamp: new Date().toISOString(),
    });
  }
}

export default new CallLoggingService();
