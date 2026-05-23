import conversationReliability from '../../services/voice/conversationReliability.service';
import type {
  BookingSlots,
  VoiceSessionState,
  VoiceSlotState,
} from '../../types/voice.types';

const confirmed = <T>(value: T): VoiceSlotState<T> => ({
  value,
  status: 'confirmed',
  source: 'user_input',
});

const inferred = <T>(value: T): VoiceSlotState<T> => ({
  value,
  status: 'inferred',
  source: 'user_input',
});

const missing = <T>(): VoiceSlotState<T> => ({
  value: null,
  status: 'missing',
  source: 'unknown',
});

function baseSession(
  overrides: Partial<VoiceSessionState> = {}
): VoiceSessionState {
  return {
    call_id: 'call-001',
    restaurant_id: 'rest-001',
    intent: 'new_booking',
    language: 'fr',
    slots: {},
    confirmation_status: 'not_required',
    backend_action_status: 'idle',
    ...overrides,
  };
}

describe('ConversationReliabilityService — intent detection', () => {
  it('returns unknown for an empty transcript', () => {
    expect(conversationReliability.detectIntent('', 'fr')).toBe('unknown');
  });

  it('detects new_booking in French', () => {
    expect(
      conversationReliability.detectIntent('Je voudrais réserver une table', 'fr')
    ).toBe('new_booking');
  });

  it('detects new_booking in English', () => {
    expect(
      conversationReliability.detectIntent('I want to book a table', 'en')
    ).toBe('new_booking');
  });

  it('returns unknown when two intents both match (ambiguous)', () => {
    const out = conversationReliability.detectIntent(
      'Je veux annuler ma réservation et modifier une autre',
      'fr'
    );
    expect(out).toBe('unknown');
  });

  it('detects question_hours', () => {
    expect(
      conversationReliability.detectIntent('vous êtes ouvert ?', 'fr')
    ).toBe('question_hours');
  });
});

describe('ConversationReliabilityService — booking gate (anti-hallucination)', () => {
  it('asks for clarification when intent is unknown', () => {
    const session = baseSession({ intent: 'unknown' });
    const decision = conversationReliability.decideNextAction(session);

    expect(decision.action.type).toBe('ask_clarification');
    expect(decision.can_proceed).toBe(false);
    expect(decision.blocking_reasons).toContain('intent_unknown');
  });

  it('blocks booking when guest_count is missing ("tomorrow evening for two" missing time)', () => {
    const session = baseSession({
      slots: {
        first_name: confirmed('Karim'),
        last_name: confirmed('Dubois'),
        phone: confirmed('+33612345678'),
        guest_count: confirmed(2),
        date: confirmed('2026-05-24'),
        // time deliberately missing
      },
    });

    const decision = conversationReliability.decideNextAction(session);
    expect(decision.can_proceed).toBe(false);
    expect(decision.action.type).toBe('ask_clarification');
    if (decision.action.type === 'ask_clarification') {
      expect(decision.action.field).toBe('time');
    }
    expect(decision.missing_critical).toContain('time');
  });

  it('blocks booking when a slot is inferred (not yet confirmed)', () => {
    const session = baseSession({
      slots: {
        first_name: confirmed('Karim'),
        last_name: confirmed('Dubois'),
        phone: confirmed('+33612345678'),
        guest_count: inferred(4),
        date: confirmed('2026-05-24'),
        time: confirmed('20:00'),
      },
    });

    const decision = conversationReliability.decideNextAction(session);
    expect(decision.can_proceed).toBe(false);
    expect(decision.action.type).toBe('ask_clarification');
    expect(decision.inferred_critical).toContain('guest_count');
  });

  it('asks for final confirmation when all critical slots are confirmed', () => {
    const session = baseSession({
      slots: {
        first_name: confirmed('Karim'),
        last_name: confirmed('Dubois'),
        phone: confirmed('+33612345678'),
        guest_count: confirmed(4),
        date: confirmed('2026-05-24'),
        time: confirmed('20:00'),
      },
      confirmation_status: 'not_required',
    });

    const decision = conversationReliability.decideNextAction(session);
    expect(decision.action.type).toBe('ask_confirmation');
    expect(decision.can_proceed).toBe(false);
    expect(decision.blocking_reasons).toContain('awaiting_final_confirmation');
  });

  it('proceeds to booking only after explicit confirmation', () => {
    const session = baseSession({
      slots: {
        first_name: confirmed('Karim'),
        last_name: confirmed('Dubois'),
        phone: confirmed('+33612345678'),
        guest_count: confirmed(4),
        date: confirmed('2026-05-24'),
        time: confirmed('20:00'),
      },
      confirmation_status: 'confirmed',
    });

    const decision = conversationReliability.decideNextAction(session);
    expect(decision.action.type).toBe('proceed_to_booking');
    expect(decision.can_proceed).toBe(true);
  });

  it('routes private_event to a human', () => {
    const session = baseSession({ intent: 'private_event' });
    const decision = conversationReliability.decideNextAction(session);
    expect(decision.action.type).toBe('fallback_human');
  });

  it('routes speak_to_human to a human', () => {
    const session = baseSession({ intent: 'speak_to_human' });
    const decision = conversationReliability.decideNextAction(session);
    expect(decision.action.type).toBe('fallback_human');
  });

  it('answers informational intents without going through booking', () => {
    const session = baseSession({ intent: 'question_hours' });
    const decision = conversationReliability.decideNextAction(session);
    expect(decision.action.type).toBe('answer_question');
    expect(decision.can_proceed).toBe(true);
  });
});

describe('ConversationReliabilityService — canPerformBackendAction guard', () => {
  it('rejects when intent is not new_booking', () => {
    const session = baseSession({ intent: 'question_hours' });
    const guard = conversationReliability.canPerformBackendAction(session);
    expect(guard.allowed).toBe(false);
    expect(guard.reason).toBe('intent_not_supported_for_action');
  });

  it('rejects when any critical field is not confirmed', () => {
    const session = baseSession({
      slots: {
        first_name: confirmed('Karim'),
        last_name: confirmed('Dubois'),
        phone: confirmed('+33612345678'),
        guest_count: inferred(4),
        date: confirmed('2026-05-24'),
        time: confirmed('20:00'),
      },
      confirmation_status: 'confirmed',
    });

    const guard = conversationReliability.canPerformBackendAction(session);
    expect(guard.allowed).toBe(false);
    expect(guard.reason).toBe('field_not_confirmed:guest_count');
  });

  it('rejects when final confirmation is missing', () => {
    const session = baseSession({
      slots: {
        first_name: confirmed('Karim'),
        last_name: confirmed('Dubois'),
        phone: confirmed('+33612345678'),
        guest_count: confirmed(4),
        date: confirmed('2026-05-24'),
        time: confirmed('20:00'),
      },
      confirmation_status: 'pending',
    });

    const guard = conversationReliability.canPerformBackendAction(session);
    expect(guard.allowed).toBe(false);
    expect(guard.reason).toBe('final_confirmation_missing');
  });

  it('allows booking only when every gate is satisfied', () => {
    const session = baseSession({
      slots: {
        first_name: confirmed('Karim'),
        last_name: confirmed('Dubois'),
        phone: confirmed('+33612345678'),
        guest_count: confirmed(4),
        date: confirmed('2026-05-24'),
        time: confirmed('20:00'),
      },
      confirmation_status: 'confirmed',
    });

    const guard = conversationReliability.canPerformBackendAction(session);
    expect(guard.allowed).toBe(true);
    expect(guard.reason).toBeNull();
  });
});

describe('ConversationReliabilityService — confirmation parser', () => {
  it('detects French positive confirmation', () => {
    expect(conversationReliability.parseConfirmation('oui', 'fr')).toBe(
      'confirmed'
    );
    expect(
      conversationReliability.parseConfirmation("c'est ça", 'fr')
    ).toBe('confirmed');
  });

  it('detects French negative confirmation', () => {
    expect(conversationReliability.parseConfirmation('non', 'fr')).toBe(
      'rejected'
    );
  });

  it('detects English positive confirmation', () => {
    expect(
      conversationReliability.parseConfirmation('yes', 'en')
    ).toBe('confirmed');
  });

  it('returns unclear on ambiguous input', () => {
    expect(
      conversationReliability.parseConfirmation('peut-être', 'fr')
    ).toBe('unclear');
  });

  it('returns unclear on empty input', () => {
    expect(conversationReliability.parseConfirmation('', 'fr')).toBe('unclear');
  });
});

describe('ConversationReliabilityService — booking summary', () => {
  it('builds a French confirmation summary with all key fields', () => {
    const slots: Partial<BookingSlots> = {
      first_name: confirmed('Karim'),
      last_name: confirmed('Dubois'),
      phone: confirmed('+33612345678'),
      guest_count: confirmed(4),
      date: confirmed('2026-05-24'),
      time: confirmed('20:00'),
    };

    const summary = conversationReliability.buildBookingSummary(slots, 'fr');
    expect(summary).toContain('Karim');
    expect(summary).toContain('Dubois');
    expect(summary).toContain('4 personnes');
    expect(summary).toContain('2026-05-24');
    expect(summary).toContain('20:00');
  });

  it('singularises when only one guest', () => {
    const slots: Partial<BookingSlots> = {
      first_name: confirmed('Karim'),
      last_name: confirmed('Dubois'),
      phone: confirmed('+33612345678'),
      guest_count: confirmed(1),
      date: confirmed('2026-05-24'),
      time: confirmed('20:00'),
    };

    const summary = conversationReliability.buildBookingSummary(slots, 'fr');
    expect(summary).toContain('1 personne,');
    expect(summary).not.toContain('1 personnes');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CRITICAL TESTS — Phase 6 Anti-Hallucination Gates
// ─────────────────────────────────────────────────────────────────────────────

describe('ConversationReliabilityService — CRITICAL: premature confirmation', () => {
  it('rejects confirmation received before pending status (early affirmation)', () => {
    const session = baseSession({
      slots: {
        first_name: confirmed('Karim'),
        last_name: confirmed('Dubois'),
        phone: confirmed('+33612345678'),
        guest_count: confirmed(4),
        date: confirmed('2026-05-24'),
        time: confirmed('20:00'),
      },
      confirmation_status: 'not_required', // NOT 'pending'
    });

    const guard = conversationReliability.canPerformBackendAction(session);
    expect(guard.allowed).toBe(false);
    expect(guard.reason).toContain('confirmation');
  });
});

describe('ConversationReliabilityService — CRITICAL: accent normalization', () => {
  it('normalizes accents in confirmation parsing ("c\'est ça" normalizes to match "c est ca")', () => {
    const result1 = conversationReliability.parseConfirmation("c'est ça", 'fr');
    const result2 = conversationReliability.parseConfirmation('c est ca', 'fr');
    expect(result1).toBe('confirmed');
    expect(result2).toBe('confirmed');
    expect(result1).toBe(result2);
  });
});

describe('ConversationReliabilityService — CRITICAL: time inferred blocking', () => {
  it('blocks booking when time is inferred (e.g., "soir")', () => {
    const session = baseSession({
      slots: {
        first_name: confirmed('Karim'),
        last_name: confirmed('Dubois'),
        phone: confirmed('+33612345678'),
        guest_count: confirmed(4),
        date: confirmed('2026-05-24'),
        time: inferred('19:00'), // Time inferred from "soir"
      },
      confirmation_status: 'confirmed',
    });

    const guard = conversationReliability.canPerformBackendAction(session);
    expect(guard.allowed).toBe(false);
    expect(guard.reason).toBe('field_not_confirmed:time');
  });
});

describe('ConversationReliabilityService — CRITICAL: backend failure messaging', () => {
  it('never returns "réservation confirmée" when backend action status is failed', () => {
    const session = baseSession({
      slots: {
        first_name: confirmed('Karim'),
        last_name: confirmed('Dubois'),
        phone: confirmed('+33612345678'),
        guest_count: confirmed(4),
        date: confirmed('2026-05-24'),
        time: confirmed('20:00'),
      },
      confirmation_status: 'confirmed',
      backend_action_status: 'failed',
    });

    const decision = conversationReliability.decideNextAction(session);
    expect(decision.action.type).not.toBe('proceed_to_booking');
  });
});

describe('ConversationReliabilityService — CRITICAL: no forced booking on unavailability', () => {
  it('rejects when availability check returns no slots (never force booking)', () => {
    const session = baseSession({
      slots: {
        first_name: confirmed('Karim'),
        last_name: confirmed('Dubois'),
        phone: confirmed('+33612345678'),
        guest_count: confirmed(4),
        date: confirmed('2026-05-24'),
        time: confirmed('20:00'),
      },
      confirmation_status: 'confirmed',
      backend_action_status: 'availability_check_failed',
    });

    const decision = conversationReliability.decideNextAction(session);
    expect(decision.action.type).not.toBe('proceed_to_booking');
    expect(decision.action.type).toBe('ask_clarification');
  });
});
