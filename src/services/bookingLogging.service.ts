// ============================================
// Booking Logging Service — Observability
//
// Structured logging for:
//   - Booking creation (manual, phone, web)
//   - Availability checks
//   - Customer uperts
//   - Booking failures
//
// Used by dashboard and voice flows.
// ============================================

import logger from '../lib/logger';
import type { BookingEvent, BookingEventType } from '../types/voice.types';

interface BookingEventInput {
  booking_id?: string | null;
  restaurant_id: string;
  event_type: BookingEventType;
  source: 'manual' | 'phone' | 'web' | 'api';
  payload: Record<string, unknown>;
  call_id?: string | null;
}

class BookingLoggingService {
  // Emit structured booking event
  emit(input: BookingEventInput): void {
    const event: BookingEvent = {
      booking_id: input.booking_id || null,
      restaurant_id: input.restaurant_id,
      event_type: input.event_type,
      source: input.source,
      payload: input.payload,
      timestamp: new Date().toISOString(),
      call_id: input.call_id || null,
    };

    logger.info(
      {
        action: 'booking_event',
        event_type: event.event_type,
        booking_id: event.booking_id,
        restaurant_id: event.restaurant_id,
        source: event.source,
        call_id: event.call_id,
        payload: event.payload,
      },
      `booking.${event.event_type}`
    );
  }

  bookingCreated(input: {
    booking_id: string;
    restaurant_id: string;
    source: 'manual' | 'phone' | 'web';
    date: string;
    time: string;
    covers: number;
    call_id?: string;
  }): void {
    // NO PII in logs (GDPR/CCPA). Only non-identifying booking metadata.
    this.emit({
      booking_id: input.booking_id,
      restaurant_id: input.restaurant_id,
      event_type: 'booking_created',
      source: input.source,
      payload: {
        date: input.date,
        time: input.time,
        covers: input.covers,
      },
      call_id: input.call_id,
    });
  }

  bookingConfirmed(input: {
    booking_id: string;
    restaurant_id: string;
    source: 'manual' | 'phone' | 'web';
    call_id?: string;
  }): void {
    this.emit({
      booking_id: input.booking_id,
      restaurant_id: input.restaurant_id,
      event_type: 'booking_confirmed',
      source: input.source,
      payload: {},
      call_id: input.call_id,
    });
  }

  bookingCancelled(input: {
    booking_id: string;
    restaurant_id: string;
    reason?: string;
  }): void {
    this.emit({
      booking_id: input.booking_id,
      restaurant_id: input.restaurant_id,
      event_type: 'booking_cancelled',
      source: 'api',
      payload: {
        reason: input.reason || null,
      },
    });
  }

  bookingFailed(input: {
    restaurant_id: string;
    source: 'manual' | 'phone' | 'web';
    reason: string;
    call_id?: string;
  }): void {
    this.emit({
      restaurant_id: input.restaurant_id,
      event_type: 'booking_failed',
      source: input.source,
      payload: {
        reason: input.reason,
      },
      call_id: input.call_id,
    });
  }

  availabilityChecked(input: {
    restaurant_id: string;
    date: string;
    time: string;
    covers: number;
    available: boolean;
    alternatives?: string[];
    call_id?: string;
  }): void {
    this.emit({
      restaurant_id: input.restaurant_id,
      event_type: 'availability_checked',
      source: input.call_id ? 'phone' : 'api',
      payload: {
        date: input.date,
        time: input.time,
        covers: input.covers,
        available: input.available,
        alternatives: input.alternatives || [],
      },
      call_id: input.call_id,
    });
  }

  customerUpserted(input: {
    restaurant_id: string;
    customer_id: string;
    phone: string;
    name: string;
    call_id?: string;
  }): void {
    this.emit({
      restaurant_id: input.restaurant_id,
      event_type: 'customer_upserted',
      source: input.call_id ? 'phone' : 'api',
      payload: {
        customer_id: input.customer_id,
        phone: 'redacted',
        name: input.name,
      },
      call_id: input.call_id,
    });
  }
}

export default new BookingLoggingService();
