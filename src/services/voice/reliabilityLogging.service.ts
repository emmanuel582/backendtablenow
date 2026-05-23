// ============================================
// Reliability Logging Service — Voice Core
//
// Structured logging for anti-hallucination gates:
//   - Intent classification (passed/blocked)
//   - Slot field validation (missing/inferred/confirmed)
//   - Final confirmation gates
//   - Availability checks
//   - Backend action guards
//
// Critical for observability and debugging voice flow.
// ============================================

import logger from '../../lib/logger';
import type { ReliabilityEvent, ReliabilityGate, CriticalBookingField } from '../../types/voice.types';

class ReliabilityLoggingService {
  emit(input: Omit<ReliabilityEvent, 'timestamp'>): void {
    const event: ReliabilityEvent = {
      ...input,
      timestamp: new Date().toISOString(),
    };

    const level = event.event_type === 'gate_passed' ? 'debug' : 'warn';

    const logFn = level === 'debug' ? logger.debug : logger.warn;

    logFn(
      {
        action: 'reliability_gate',
        call_id: event.call_id,
        restaurant_id: event.restaurant_id,
        gate: event.gate,
        event_type: event.event_type,
        payload: event.payload,
      },
      `voice.reliability.${event.gate}.${event.event_type}`
    );
  }

  intentClassificationPassed(input: {
    call_id: string;
    restaurant_id: string;
    intent: string;
    confidence?: number;
  }): void {
    this.emit({
      call_id: input.call_id,
      restaurant_id: input.restaurant_id,
      event_type: 'gate_passed',
      gate: 'intent_classification',
      payload: {
        intent: input.intent,
        confidence: input.confidence || null,
      },
    });
  }

  intentClassificationBlocked(input: {
    call_id: string;
    restaurant_id: string;
    ambiguous_intents: string[];
    transcript: string;
  }): void {
    this.emit({
      call_id: input.call_id,
      restaurant_id: input.restaurant_id,
      event_type: 'gate_blocked',
      gate: 'intent_classification',
      payload: {
        reason: 'ambiguous_intents',
        ambiguous_intents: input.ambiguous_intents,
        transcript_length: input.transcript.length,
      },
    });
  }

  criticalFieldPassed(input: {
    call_id: string;
    restaurant_id: string;
    field: CriticalBookingField;
    status: 'missing' | 'inferred' | 'confirmed';
  }): void {
    if (input.status === 'confirmed') {
      this.emit({
        call_id: input.call_id,
        restaurant_id: input.restaurant_id,
        event_type: 'gate_passed',
        gate: 'critical_field_missing',
        payload: {
          field: input.field,
          status: input.status,
        },
      });
    }
  }

  criticalFieldBlocked(input: {
    call_id: string;
    restaurant_id: string;
    field: CriticalBookingField;
    status: 'missing' | 'inferred';
    reason: string;
  }): void {
    const gate: ReliabilityGate = input.status === 'inferred'
      ? 'critical_field_inferred'
      : 'critical_field_missing';

    this.emit({
      call_id: input.call_id,
      restaurant_id: input.restaurant_id,
      event_type: 'gate_blocked',
      gate,
      payload: {
        field: input.field,
        status: input.status,
        reason: input.reason,
      },
    });
  }

  confirmationGatePassed(input: {
    call_id: string;
    restaurant_id: string;
  }): void {
    this.emit({
      call_id: input.call_id,
      restaurant_id: input.restaurant_id,
      event_type: 'gate_passed',
      gate: 'final_confirmation_missing',
      payload: {
        message: 'confirmation_received',
      },
    });
  }

  confirmationGateBlocked(input: {
    call_id: string;
    restaurant_id: string;
    reason: 'pending' | 'rejected';
  }): void {
    this.emit({
      call_id: input.call_id,
      restaurant_id: input.restaurant_id,
      event_type: 'gate_blocked',
      gate: 'final_confirmation_missing',
      payload: {
        reason: input.reason,
      },
    });
  }

  availabilityCheckPassed(input: {
    call_id: string;
    restaurant_id: string;
    date: string;
    time: string;
    covers: number;
  }): void {
    this.emit({
      call_id: input.call_id,
      restaurant_id: input.restaurant_id,
      event_type: 'gate_passed',
      gate: 'availability_check',
      payload: {
        date: input.date,
        time: input.time,
        covers: input.covers,
        status: 'available',
      },
    });
  }

  availabilityCheckBlocked(input: {
    call_id: string;
    restaurant_id: string;
    date: string;
    time: string;
    covers: number;
    alternatives: string[];
  }): void {
    this.emit({
      call_id: input.call_id,
      restaurant_id: input.restaurant_id,
      event_type: 'gate_blocked',
      gate: 'availability_check',
      payload: {
        date: input.date,
        time: input.time,
        covers: input.covers,
        alternatives: input.alternatives,
        status: 'unavailable',
      },
    });
  }

  backendGuardPassed(input: {
    call_id: string;
    restaurant_id: string;
  }): void {
    this.emit({
      call_id: input.call_id,
      restaurant_id: input.restaurant_id,
      event_type: 'gate_passed',
      gate: 'backend_guard',
      payload: {
        message: 'all_guards_passed',
      },
    });
  }

  backendGuardBlocked(input: {
    call_id: string;
    restaurant_id: string;
    reason: string;
  }): void {
    this.emit({
      call_id: input.call_id,
      restaurant_id: input.restaurant_id,
      event_type: 'gate_blocked',
      gate: 'backend_guard',
      payload: {
        reason: input.reason,
      },
    });
  }
}

export default new ReliabilityLoggingService();
