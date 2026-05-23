// ============================================
// Critical test: orchestrateBooking() must NEVER force a booking when
// availability returns false. It must propose alternatives instead.
// ============================================

jest.mock('../../config/supabase', () => ({
  __esModule: true,
  default: {
    rpc: jest.fn(),
    from: jest.fn(),
  },
}));

jest.mock('../../services/booking.service', () => ({
  createBooking: jest.fn(),
}));

jest.mock('../../services/bookingLogging.service', () => ({
  __esModule: true,
  default: {
    bookingCreated: jest.fn(),
    bookingFailed: jest.fn(),
  },
}));

jest.mock('../../services/voice/reliabilityLogging.service', () => ({
  __esModule: true,
  default: {
    backendGuardPassed: jest.fn(),
    backendGuardBlocked: jest.fn(),
    availabilityCheckPassed: jest.fn(),
    availabilityCheckBlocked: jest.fn(),
  },
}));

jest.mock('../../services/errorTracking.service', () => ({
  __esModule: true,
  default: {
    bookingCreationFailed: jest.fn(),
  },
}));

import supabase from '../../config/supabase';
import bookingOrchestration from '../../services/voice/bookingOrchestration.service';
import { createBooking } from '../../services/booking.service';
import type { ResolvedVoiceRestaurant, VoiceSessionState } from '../../types/voice.types';

const restaurant: ResolvedVoiceRestaurant = {
  id: 'rest-001',
  name: 'Test Resto',
  slug: 'test-resto',
  address: '1 rue Test',
  phone: '+33100000000',
  opening_hours: {},
  language: 'fr',
};

function confirmedSession(): VoiceSessionState {
  return {
    call_id: 'call-orch-001',
    restaurant_id: 'rest-001',
    intent: 'new_booking',
    language: 'fr',
    slots: {
      first_name: { value: 'Karim', status: 'confirmed', source: 'user_input' },
      last_name: { value: 'Dubois', status: 'confirmed', source: 'user_input' },
      phone: { value: '+33612345678', status: 'confirmed', source: 'user_input' },
      guest_count: { value: 4, status: 'confirmed', source: 'user_input' },
      date: { value: '2026-05-24', status: 'confirmed', source: 'user_input' },
      time: { value: '20:00', status: 'confirmed', source: 'user_input' },
    },
    confirmation_status: 'confirmed',
    backend_action_status: 'idle',
  };
}

describe('BookingOrchestrationService — CRITICAL: no booking when unavailable', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns unavailable + alternatives, never calls createBooking, when requested slot is full', async () => {
    (supabase.rpc as jest.Mock).mockResolvedValue({
      data: [
        { slot_time: '20:00', available: false },
        { slot_time: '19:30', available: true },
        { slot_time: '20:30', available: true },
      ],
      error: null,
    });

    const result = await bookingOrchestration.orchestrateBooking(restaurant, confirmedSession());

    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.alternatives).toEqual(expect.arrayContaining(['19:30', '20:30']));
      expect(result.message).toMatch(/(19:30|20:30)/);
    }
    expect(createBooking).not.toHaveBeenCalled();
  });

  it('returns unavailable with empty alternatives when RPC fails — never silently books', async () => {
    (supabase.rpc as jest.Mock).mockResolvedValue({
      data: null,
      error: { message: 'rpc failed' },
    });

    const result = await bookingOrchestration.orchestrateBooking(restaurant, confirmedSession());

    expect(result.status).toBe('unavailable');
    expect(createBooking).not.toHaveBeenCalled();
  });

  it('returns needs_clarification when reliability guard blocks (intent not new_booking)', async () => {
    const session = confirmedSession();
    session.intent = 'question_hours';

    const result = await bookingOrchestration.orchestrateBooking(restaurant, session);

    expect(result.status).toBe('needs_clarification');
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(createBooking).not.toHaveBeenCalled();
  });

  it('proceeds to createBooking only when guard passes AND availability is true', async () => {
    (supabase.rpc as jest.Mock).mockResolvedValue({
      data: [{ slot_time: '20:00', available: true }],
      error: null,
    });
    (createBooking as jest.Mock).mockResolvedValue({ id: 'booking-001' });

    const result = await bookingOrchestration.orchestrateBooking(restaurant, confirmedSession());

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.booking_id).toBe('booking-001');
    }
    expect(createBooking).toHaveBeenCalledTimes(1);
  });
});
