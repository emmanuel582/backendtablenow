// ============================================
// Conversation Reliability Service — Voice Core
//
// CRITICAL anti-hallucination layer.
//
// Responsibilities:
//   1. Classify intent (or return unknown — never guess silently)
//   2. Track slot state (missing / inferred / confirmed)
//   3. Block any backend action while critical fields are uncertain
//   4. Force an explicit confirmation gate before booking/modify/cancel
//   5. Return the next safe action: ask_clarification | ask_confirmation |
//      proceed_to_booking | fallback_human | answer_question
//
// This service NEVER calls the database or any provider.
// It is pure decision logic so it can be unit tested in isolation.
// ============================================

import logger from '../../lib/logger';
import type {
  BookingSlots,
  CriticalBookingField,
  VoiceAction,
  VoiceIntent,
  VoiceReliabilityDecision,
  VoiceSessionState,
  VoiceSlotState,
} from '../../types/voice.types';
import { CRITICAL_BOOKING_FIELDS } from '../../types/voice.types';

// ── Intent keyword tables (kept extremely conservative on purpose) ──────────

const INTENT_KEYWORDS_FR: Record<VoiceIntent, readonly string[]> = {
  new_booking: ['réserver', 'réservation', 'une table', 'reserver'],
  modify_booking: ['modifier', 'changer ma réservation', 'décaler'],
  cancel_booking: ['annuler', 'annulation', 'supprimer ma réservation'],
  question_hours: ['horaires', 'ouvert', 'fermé', 'à quelle heure'],
  question_address: ['adresse', 'où', 'situé', 'comment venir'],
  question_menu: ['menu', 'carte', 'plats', 'prix'],
  question_allergens: ['allergie', 'allergène', 'gluten', 'sans lactose'],
  private_event: ['privatiser', 'groupe', 'événement privé', 'séminaire'],
  speak_to_human: ['humain', 'parler à quelqu', 'gérant', 'responsable'],
  out_of_scope: [],
  unknown: [],
};

const INTENT_KEYWORDS_EN: Record<VoiceIntent, readonly string[]> = {
  new_booking: ['book', 'reserve', 'reservation', 'table for'],
  modify_booking: ['change my booking', 'modify', 'reschedule'],
  cancel_booking: ['cancel', 'cancellation'],
  question_hours: ['hours', 'open', 'closed', 'what time'],
  question_address: ['address', 'where are you', 'directions', 'located'],
  question_menu: ['menu', 'food', 'dishes', 'price'],
  question_allergens: ['allergy', 'allergen', 'gluten', 'lactose'],
  private_event: ['private event', 'group of', 'party of'],
  speak_to_human: ['human', 'manager', 'speak to someone', 'talk to a person'],
  out_of_scope: [],
  unknown: [],
};

class ConversationReliabilityService {
  // ── Intent classification (conservative) ───────────────────────────────────

  detectIntent(transcript: string, language: 'fr' | 'en'): VoiceIntent {
    if (!transcript || transcript.trim().length === 0) {
      return 'unknown';
    }

    const lower = transcript.toLowerCase();
    const table =
      language === 'en' ? INTENT_KEYWORDS_EN : INTENT_KEYWORDS_FR;

    const matches: VoiceIntent[] = [];
    for (const intent of Object.keys(table) as VoiceIntent[]) {
      if (intent === 'unknown' || intent === 'out_of_scope') continue;
      const keywords = table[intent];
      if (keywords.some((kw) => lower.includes(kw))) {
        matches.push(intent);
      }
    }

    if (matches.length === 0) return 'unknown';
    if (matches.length > 1) {
      // Ambiguous on purpose → escalate to unknown so the agent asks
      logger.info(
        { action: 'detect_intent', matches },
        'Multiple intents matched, returning unknown for safety'
      );
      return 'unknown';
    }

    return matches[0];
  }

  // ── Slot helpers ───────────────────────────────────────────────────────────

  private isSlotConfirmed(slot: VoiceSlotState<unknown> | undefined): boolean {
    return slot?.status === 'confirmed' && slot.value !== null;
  }

  private isSlotInferred(slot: VoiceSlotState<unknown> | undefined): boolean {
    return slot?.status === 'inferred';
  }

  private isSlotMissing(slot: VoiceSlotState<unknown> | undefined): boolean {
    return !slot || slot.status === 'missing' || slot.value === null;
  }

  // ── Core decision logic ────────────────────────────────────────────────────

  decideNextAction(session: VoiceSessionState): VoiceReliabilityDecision {
    const lang = session.language;

    if (session.intent === 'unknown') {
      return {
        action: {
          type: 'ask_clarification',
          field: 'intent',
          message:
            lang === 'en'
              ? 'Would you like to book, modify a booking, or ask a question?'
              : 'Souhaitez-vous réserver, modifier une réservation, ou poser une question ?',
        },
        blocking_reasons: ['intent_unknown'],
        missing_critical: [],
        inferred_critical: [],
        can_proceed: false,
      };
    }

    if (
      session.intent === 'question_hours' ||
      session.intent === 'question_address' ||
      session.intent === 'question_menu' ||
      session.intent === 'question_allergens'
    ) {
      return {
        action: { type: 'answer_question', intent: session.intent },
        blocking_reasons: [],
        missing_critical: [],
        inferred_critical: [],
        can_proceed: true,
      };
    }

    if (
      session.intent === 'speak_to_human' ||
      session.intent === 'private_event' ||
      session.intent === 'out_of_scope'
    ) {
      return {
        action: {
          type: 'fallback_human',
          reason: session.intent,
        },
        blocking_reasons: [`requires_human_${session.intent}`],
        missing_critical: [],
        inferred_critical: [],
        can_proceed: false,
      };
    }

    if (session.intent === 'new_booking') {
      return this.decideForBooking(session);
    }

    if (
      session.intent === 'modify_booking' ||
      session.intent === 'cancel_booking'
    ) {
      // v1: route to human until orchestration logic exists
      return {
        action: {
          type: 'fallback_human',
          reason: `${session.intent}_not_supported_v1`,
        },
        blocking_reasons: ['v1_no_modify_cancel_flow'],
        missing_critical: [],
        inferred_critical: [],
        can_proceed: false,
      };
    }

    return {
      action: {
        type: 'fallback_human',
        reason: 'unhandled_intent',
      },
      blocking_reasons: ['unhandled_intent'],
      missing_critical: [],
      inferred_critical: [],
      can_proceed: false,
    };
  }

  // ── Booking-specific decision tree ─────────────────────────────────────────

  private decideForBooking(
    session: VoiceSessionState
  ): VoiceReliabilityDecision {
    const slots = (session.slots ?? {}) as Partial<BookingSlots>;
    const lang = session.language;

    const missing: CriticalBookingField[] = [];
    const inferred: CriticalBookingField[] = [];

    for (const field of CRITICAL_BOOKING_FIELDS) {
      const slot = slots[field];
      if (this.isSlotMissing(slot)) {
        missing.push(field);
      } else if (this.isSlotInferred(slot)) {
        inferred.push(field);
      }
    }

    if (missing.length > 0) {
      const next = missing[0];
      return {
        action: {
          type: 'ask_clarification',
          field: next,
          message: this.askMessageFor(next, lang),
        },
        blocking_reasons: missing.map((f) => `missing:${f}`),
        missing_critical: missing,
        inferred_critical: inferred,
        can_proceed: false,
      };
    }

    if (inferred.length > 0) {
      const next = inferred[0];
      return {
        action: {
          type: 'ask_clarification',
          field: next,
          message: this.confirmMessageFor(next, slots, lang),
        },
        blocking_reasons: inferred.map((f) => `inferred:${f}`),
        missing_critical: missing,
        inferred_critical: inferred,
        can_proceed: false,
      };
    }

    if (session.confirmation_status !== 'confirmed') {
      return {
        action: {
          type: 'ask_confirmation',
          summary: this.buildBookingSummary(slots, lang),
        },
        blocking_reasons: ['awaiting_final_confirmation'],
        missing_critical: [],
        inferred_critical: [],
        can_proceed: false,
      };
    }

    if (session.backend_action_status === 'in_progress') {
      return {
        action: {
          type: 'ask_confirmation',
          summary: this.buildBookingSummary(slots, lang),
        },
        blocking_reasons: ['backend_action_in_progress'],
        missing_critical: [],
        inferred_critical: [],
        can_proceed: false,
      };
    }

    return {
      action: { type: 'proceed_to_booking' },
      blocking_reasons: [],
      missing_critical: [],
      inferred_critical: [],
      can_proceed: true,
    };
  }

  // ── Message factories ──────────────────────────────────────────────────────

  private askMessageFor(
    field: CriticalBookingField,
    lang: 'fr' | 'en'
  ): string {
    const messages: Record<CriticalBookingField, { fr: string; en: string }> = {
      first_name: {
        fr: 'À quel prénom souhaitez-vous réserver ?',
        en: 'What is the first name for the reservation?',
      },
      last_name: {
        fr: 'Quel est votre nom de famille ?',
        en: 'And your last name, please?',
      },
      phone: {
        fr: 'Pouvez-vous me confirmer votre numéro de téléphone ?',
        en: 'Could you confirm your phone number?',
      },
      guest_count: {
        fr: 'Pour combien de personnes ?',
        en: 'For how many people?',
      },
      date: {
        fr: 'Pour quelle date souhaitez-vous réserver ?',
        en: 'What date would you like to book?',
      },
      time: {
        fr: 'À quelle heure ?',
        en: 'At what time?',
      },
    };
    return messages[field][lang];
  }

  private confirmMessageFor(
    field: CriticalBookingField,
    slots: Partial<BookingSlots>,
    lang: 'fr' | 'en'
  ): string {
    const value = slots[field]?.value;
    if (value === null || value === undefined) {
      return this.askMessageFor(field, lang);
    }

    const tplFr: Record<CriticalBookingField, string> = {
      first_name: `J'ai noté le prénom "${value}", c'est correct ?`,
      last_name: `J'ai noté le nom "${value}", c'est correct ?`,
      phone: `J'ai noté le numéro ${value}, c'est correct ?`,
      guest_count: `J'ai compris ${value} personnes, c'est bien cela ?`,
      date: `J'ai compris la date du ${value}, c'est bien cela ?`,
      time: `J'ai compris ${value}, c'est bien l'heure souhaitée ?`,
    };

    const tplEn: Record<CriticalBookingField, string> = {
      first_name: `I noted the first name "${value}", is that correct?`,
      last_name: `I noted the last name "${value}", is that correct?`,
      phone: `I noted the phone number ${value}, is that correct?`,
      guest_count: `I understood ${value} people, is that right?`,
      date: `I understood the date ${value}, is that right?`,
      time: `I understood ${value}, is that the correct time?`,
    };

    return lang === 'en' ? tplEn[field] : tplFr[field];
  }

  buildBookingSummary(
    slots: Partial<BookingSlots>,
    lang: 'fr' | 'en'
  ): string {
    const first = slots.first_name?.value ?? '';
    const last = slots.last_name?.value ?? '';
    const phone = slots.phone?.value ?? '';
    const covers = slots.guest_count?.value ?? 0;
    const date = slots.date?.value ?? '';
    const time = slots.time?.value ?? '';

    if (lang === 'en') {
      return `Confirming: reservation for ${first} ${last}, ${covers} people, on ${date} at ${time}, phone ${phone}. Is that correct?`;
    }
    return `Je confirme : réservation au nom de ${first} ${last}, ${covers} personne${covers > 1 ? 's' : ''}, le ${date} à ${time}, téléphone ${phone}. C'est bien cela ?`;
  }

  // ── Confirmation parsing (extremely strict) ────────────────────────────────

  parseConfirmation(
    transcript: string,
    language: 'fr' | 'en'
  ): 'confirmed' | 'rejected' | 'unclear' {
    if (!transcript) return 'unclear';
    const t = transcript.trim().toLowerCase();

    const positiveFr = ['oui', "c'est ça", "c'est bien ça", 'exact', 'parfait'];
    const negativeFr = ['non', 'pas du tout', 'incorrect', 'attendez'];
    const positiveEn = ['yes', 'correct', 'thats right', "that's right", 'exactly'];
    const negativeEn = ['no', 'not correct', 'wrong', 'wait'];

    const positives = language === 'en' ? positiveEn : positiveFr;
    const negatives = language === 'en' ? negativeEn : negativeFr;

    const hitPositive = positives.some((p) => t === p || t.startsWith(`${p} `) || t.endsWith(` ${p}`));
    const hitNegative = negatives.some((n) => t === n || t.startsWith(`${n} `) || t.endsWith(` ${n}`));

    if (hitPositive && !hitNegative) return 'confirmed';
    if (hitNegative && !hitPositive) return 'rejected';
    return 'unclear';
  }

  // ── Pre-action guard (last line of defense) ────────────────────────────────

  canPerformBackendAction(session: VoiceSessionState): {
    allowed: boolean;
    reason: string | null;
  } {
    if (session.intent !== 'new_booking') {
      return { allowed: false, reason: 'intent_not_supported_for_action' };
    }

    const slots = (session.slots ?? {}) as Partial<BookingSlots>;

    for (const field of CRITICAL_BOOKING_FIELDS) {
      if (!this.isSlotConfirmed(slots[field])) {
        return { allowed: false, reason: `field_not_confirmed:${field}` };
      }
    }

    if (session.confirmation_status !== 'confirmed') {
      return { allowed: false, reason: 'final_confirmation_missing' };
    }

    return { allowed: true, reason: null };
  }

  // ── Action labelling for logs ──────────────────────────────────────────────

  describeAction(action: VoiceAction): string {
    switch (action.type) {
      case 'ask_clarification':
        return `ask_clarification:${action.field}`;
      case 'ask_confirmation':
        return 'ask_confirmation';
      case 'proceed_to_booking':
        return 'proceed_to_booking';
      case 'fallback_human':
        return `fallback_human:${action.reason}`;
      case 'answer_question':
        return `answer_question:${action.intent}`;
    }
  }
}

export default new ConversationReliabilityService();
