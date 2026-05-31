// ============================================
// Booking Orchestration Service — Voice Core
//
// Responsibilities:
//   - Check availability for a confirmed slot
//   - Create a booking ONLY when conversationReliability has authorised it
//   - Never let the voice agent claim success before the backend returns
//   - Return a typed result the controller can speak back safely
//
// This service depends only on Supabase RPC + the typed BookingSlots payload.
// ============================================

import supabase from '../../config/supabase';
import logger from '../../lib/logger';
import conversationReliabilityService from './conversationReliability.service';
import { createBooking } from '../booking.service';
import bookingLogging from '../bookingLogging.service';
import reliabilityLogging from './reliabilityLogging.service';
import errorTracking from '../errorTracking.service';
import type {
  BookingOrchestrationResult,
  BookingSlots,
  ResolvedVoiceRestaurant,
  VoiceSessionState,
} from '../../types/voice.types';

interface AvailabilityCheck {
  available: boolean;
  alternatives: readonly string[];
}

class BookingOrchestrationService {
  async checkAvailability(
    restaurantId: string,
    date: string,
    time: string,
    covers: number
  ): Promise<AvailabilityCheck> {
    const { data, error } = await supabase.rpc('get_available_slots', {
      p_restaurant_id: restaurantId,
      p_date: date,
      p_covers: covers,
    });

    if (error || !data) {
      logger.error(
        { action: 'check_availability', error: error?.message },
        'Availability RPC failed'
      );
      return { available: false, alternatives: [] };
    }

    const slots = data as Array<{
      slot_time?: string;
      available?: boolean;
    }>;

    const requested = slots.find(
      (s) => s.slot_time?.slice(0, 5) === time.slice(0, 5)
    );

    if (requested?.available) {
      return { available: true, alternatives: [] };
    }

    const alternatives = slots
      .filter((s) => s.available === true)
      .map((s) => s.slot_time?.slice(0, 5))
      .filter((t): t is string => typeof t === 'string')
      .slice(0, 3);

    return { available: false, alternatives };
  }

  async orchestrateBooking(
    restaurant: ResolvedVoiceRestaurant,
    session: VoiceSessionState
  ): Promise<BookingOrchestrationResult> {
    const guard = conversationReliabilityService.canPerformBackendAction(session);

    if (!guard.allowed) {
      logger.warn(
        {
          action: 'orchestrate_booking',
          call_id: session.call_id,
          reason: guard.reason,
        },
        'Booking blocked by reliability guard'
      );

      reliabilityLogging.backendGuardBlocked({
        call_id: session.call_id,
        restaurant_id: restaurant.id,
        reason: guard.reason || 'unknown',
      });

      const lang = session.language;
      const message =
        lang === 'en'
          ? 'I need a few more details before confirming the booking.'
          : "J'ai besoin de quelques précisions avant de confirmer la réservation.";

      return {
        status: 'needs_clarification',
        missing_fields: [],
        message,
      };
    }

    reliabilityLogging.backendGuardPassed({
      call_id: session.call_id,
      restaurant_id: restaurant.id,
    });

    const slots = session.slots as Required<
      Pick<
        BookingSlots,
        | 'first_name'
        | 'last_name'
        | 'phone'
        | 'guest_count'
        | 'date'
        | 'time'
      >
    >;

    const first_name = slots.first_name.value as string;
    const last_name = slots.last_name.value as string;
    const phone = slots.phone.value as string;
    const guest_count = slots.guest_count.value as number;
    const date = slots.date.value as string;
    const time = slots.time.value as string;
    const email = ((session.slots as any).email?.value as string | null) ?? undefined;

    const lang = session.language;

    const availability = await this.checkAvailability(
      restaurant.id,
      date,
      time,
      guest_count
    );

    if (availability.available) {
      reliabilityLogging.availabilityCheckPassed({
        call_id: session.call_id,
        restaurant_id: restaurant.id,
        date,
        time,
        covers: guest_count,
      });
    } else {
      reliabilityLogging.availabilityCheckBlocked({
        call_id: session.call_id,
        restaurant_id: restaurant.id,
        date,
        time,
        covers: guest_count,
        alternatives: [...availability.alternatives],
      });

      logger.info(
        {
          action: 'orchestrate_booking',
          call_id: session.call_id,
          restaurant_id: restaurant.id,
          alternatives: availability.alternatives,
        },
        'Slot unavailable'
      );

      const message =
        lang === 'en'
          ? `That slot is no longer available.${availability.alternatives.length ? ` Available times nearby: ${availability.alternatives.join(', ')}.` : ''}`
          : `Ce créneau n'est plus disponible.${availability.alternatives.length ? ` Créneaux proches disponibles : ${availability.alternatives.join(', ')}.` : ''}`;

      return {
        status: 'unavailable',
        alternatives: availability.alternatives,
        message,
      };
    }

    try {
      const guestName = `${first_name} ${last_name}`.trim();

      const newBooking = await createBooking(
        {
          restaurant_id: restaurant.id,
          date,
          time,
          covers: guest_count,
          guest_name: guestName,
          guest_email: email,
          guest_phone: phone,
          source: 'phone',
          guest_language: lang as 'fr' | 'en',
          idempotency_key: session.call_id,
        },
        session.call_id,
        {
          id: restaurant.id,
          name: restaurant.name,
          address: restaurant.address,
          phone: restaurant.phone,
        }
      );

      logger.info(
        {
          action: 'orchestrate_booking_success',
          call_id: session.call_id,
          restaurant_id: restaurant.id,
          booking_id: newBooking.id,
        },
        'Voice booking created'
      );

      bookingLogging.bookingCreated({
        booking_id: newBooking.id,
        restaurant_id: restaurant.id,
        source: 'phone',
        date,
        time,
        covers: guest_count,
        call_id: session.call_id,
      });

      const message =
        lang === 'en'
          ? `Your booking is confirmed for ${guest_count} ${guest_count > 1 ? 'guests' : 'guest'} on ${date} at ${time}.`
          : `Votre réservation est confirmée pour ${guest_count} personne${guest_count > 1 ? 's' : ''} le ${date} à ${time}.`;

      return {
        status: 'success',
        booking_id: newBooking.id,
        message,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'unknown';
      logger.error(
        {
          action: 'orchestrate_booking_exception',
          call_id: session.call_id,
          restaurant_id: restaurant.id,
          error: errMsg,
        },
        'Booking orchestration threw'
      );

      bookingLogging.bookingFailed({
        restaurant_id: restaurant.id,
        source: 'phone',
        reason: errMsg,
        call_id: session.call_id,
      });

      errorTracking.bookingCreationFailed({
        restaurant_id: restaurant.id,
        reason: errMsg,
        call_id: session.call_id,
      });

      const message =
        lang === 'en'
          ? 'I encountered a technical issue. Please call the restaurant directly.'
          : 'Une erreur technique est survenue. Je vous invite à rappeler le restaurant.';

      return {
        status: 'failed',
        reason: errMsg,
        message,
      };
    }
  }
}

export default new BookingOrchestrationService();
