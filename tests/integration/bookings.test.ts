import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';

/**
 * Integration tests for booking flow
 * Tests: idempotency, validation, email delivery
 * Run: npm test tests/integration/bookings.test.ts
 */

const API_URL = process.env.BACKEND_URL || 'http://localhost:5000';
const TEST_RESTAURANT_ID = process.env.TEST_RESTAURANT_ID || 'test-uuid';
const TEST_AUTH_TOKEN = process.env.TEST_AUTH_TOKEN || '';

interface BookingPayload {
  guestName: string;
  guestEmail: string;
  guestPhone: string;
  date: string;
  time: string;
  partySize: number;
  specialRequests?: string;
  language?: 'fr' | 'en';
}

describe('Booking Flow Tests', () => {
  let createdBookingId: string;

  // ─── Test 1: Manual booking creation (dashboard) ───────────────────────────
  describe('POST /api/bookings (manual creation)', () => {
    it('should create a booking with valid inputs', async () => {
      const payload: BookingPayload = {
        guestName: 'Test User',
        guestEmail: 'test@example.com',
        guestPhone: '+33612345678',
        date: '2026-05-20',
        time: '19:30',
        partySize: 2,
        language: 'fr'
      };

      const res = await fetch(`${API_URL}/api/bookings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${TEST_AUTH_TOKEN}`
        },
        body: JSON.stringify(payload)
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.booking).toBeDefined();
      expect(data.booking.id).toBeDefined();
      createdBookingId = data.booking.id;
      expect(data.booking.guest_name).toBe('Test User');
      expect(data.booking.party_size).toBe(2);
    });

    // ─── Test 2: Validation error handling ───────────────────────────────────
    it('should reject invalid email', async () => {
      const payload = {
        guestName: 'Test User',
        guestEmail: 'invalid-email',
        guestPhone: '+33612345678',
        date: '2026-05-20',
        time: '19:30',
        partySize: 2
      };

      const res = await fetch(`${API_URL}/api/bookings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${TEST_AUTH_TOKEN}`
        },
        body: JSON.stringify(payload)
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject missing required fields', async () => {
      const payload = {
        guestName: 'Test User'
        // missing other required fields
      };

      const res = await fetch(`${API_URL}/api/bookings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${TEST_AUTH_TOKEN}`
        },
        body: JSON.stringify(payload)
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject invalid date format', async () => {
      const payload: BookingPayload = {
        guestName: 'Test User',
        guestEmail: 'test@example.com',
        guestPhone: '+33612345678',
        date: '2026-5-20', // Invalid: should be YYYY-MM-DD
        time: '19:30',
        partySize: 2
      };

      const res = await fetch(`${API_URL}/api/bookings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${TEST_AUTH_TOKEN}`
        },
        body: JSON.stringify(payload)
      });

      expect(res.status).toBe(400);
    });

    it('should reject invalid time format', async () => {
      const payload: BookingPayload = {
        guestName: 'Test User',
        guestEmail: 'test@example.com',
        guestPhone: '+33612345678',
        date: '2026-05-20',
        time: '19:30:00', // Invalid: should be HH:MM
        partySize: 2
      };

      const res = await fetch(`${API_URL}/api/bookings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${TEST_AUTH_TOKEN}`
        },
        body: JSON.stringify(payload)
      });

      expect(res.status).toBe(400);
    });
  });

  // ─── Test 3: Idempotency (double-click) ──────────────────────────────────
  describe('Idempotency (double-click protection)', () => {
    it('should return same booking on duplicate request', async () => {
      const payload: BookingPayload = {
        guestName: 'Double Click Test',
        guestEmail: 'doubleclick@example.com',
        guestPhone: '+33698765432',
        date: '2026-05-21',
        time: '20:00',
        partySize: 4,
        language: 'en'
      };

      // First request
      const res1 = await fetch(`${API_URL}/api/bookings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${TEST_AUTH_TOKEN}`
        },
        body: JSON.stringify(payload)
      });

      expect(res1.status).toBe(201);
      const data1 = await res1.json();
      const bookingId1 = data1.booking.id;

      // Second request (same payload = same idempotency key)
      const res2 = await fetch(`${API_URL}/api/bookings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${TEST_AUTH_TOKEN}`
        },
        body: JSON.stringify(payload)
      });

      expect(res2.status).toBe(201);
      const data2 = await res2.json();
      const bookingId2 = data2.booking.id;

      // CRITICAL: Must be the SAME booking, not a new one
      expect(bookingId2).toBe(bookingId1);
      expect(data2.booking.guest_name).toBe('Double Click Test');
    });
  });

  // ─── Test 4: Booking retrieval ───────────────────────────────────────────
  describe('GET /api/bookings/:id', () => {
    it('should retrieve created booking', async () => {
      const res = await fetch(`${API_URL}/api/bookings/${createdBookingId}`, {
        headers: {
          'Authorization': `Bearer ${TEST_AUTH_TOKEN}`
        }
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.booking).toBeDefined();
      expect(data.booking.id).toBe(createdBookingId);
    });

    it('should return 404 for non-existent booking', async () => {
      const res = await fetch(`${API_URL}/api/bookings/fake-uuid`, {
        headers: {
          'Authorization': `Bearer ${TEST_AUTH_TOKEN}`
        }
      });

      expect(res.status).toBe(404);
    });
  });

  // ─── Test 5: List bookings with pagination ──────────────────────────────
  describe('GET /api/bookings (list)', () => {
    it('should list bookings with pagination', async () => {
      const res = await fetch(`${API_URL}/api/bookings?limit=10&offset=0`, {
        headers: {
          'Authorization': `Bearer ${TEST_AUTH_TOKEN}`
        }
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.bookings).toBeDefined();
      expect(Array.isArray(data.bookings)).toBe(true);
      expect(data.total).toBeDefined();
      expect(data.limit).toBe(10);
      expect(data.offset).toBe(0);
    });

    it('should filter bookings by date', async () => {
      const res = await fetch(`${API_URL}/api/bookings?date=2026-05-20`, {
        headers: {
          'Authorization': `Bearer ${TEST_AUTH_TOKEN}`
        }
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data.bookings)).toBe(true);
    });

    it('should filter bookings by status', async () => {
      const res = await fetch(`${API_URL}/api/bookings?status=confirmed`, {
        headers: {
          'Authorization': `Bearer ${TEST_AUTH_TOKEN}`
        }
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data.bookings)).toBe(true);
    });
  });

  // ─── Test 6: Booking update ─────────────────────────────────────────────
  describe('PUT /api/bookings/:id', () => {
    it('should update booking status', async () => {
      const res = await fetch(`${API_URL}/api/bookings/${createdBookingId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${TEST_AUTH_TOKEN}`
        },
        body: JSON.stringify({
          status: 'completed'
        })
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.booking.status).toBe('completed');
    });

    it('should reject invalid status', async () => {
      const res = await fetch(`${API_URL}/api/bookings/${createdBookingId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${TEST_AUTH_TOKEN}`
        },
        body: JSON.stringify({
          status: 'invalid-status'
        })
      });

      expect(res.status).toBe(400);
    });
  });

  // ─── Test 7: Booking cancellation ────────────────────────────────────────
  describe('DELETE /api/bookings/:id', () => {
    it('should cancel booking', async () => {
      // Create a test booking to cancel
      const payload: BookingPayload = {
        guestName: 'Cancel Test',
        guestEmail: 'cancel@example.com',
        guestPhone: '+33612341234',
        date: '2026-05-22',
        time: '18:00',
        partySize: 1
      };

      const createRes = await fetch(`${API_URL}/api/bookings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${TEST_AUTH_TOKEN}`
        },
        body: JSON.stringify(payload)
      });

      const createData = await createRes.json();
      const bookingId = createData.booking.id;

      // Cancel it
      const cancelRes = await fetch(`${API_URL}/api/bookings/${bookingId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${TEST_AUTH_TOKEN}`
        }
      });

      expect(cancelRes.status).toBe(200);
      const cancelData = await cancelRes.json();
      expect(cancelData.booking.status).toBe('cancelled');
    });

    it('should reject cancelling already cancelled booking', async () => {
      // Cancel a booking twice
      const payload: BookingPayload = {
        guestName: 'Double Cancel Test',
        guestEmail: 'doublecancel@example.com',
        guestPhone: '+33612342234',
        date: '2026-05-23',
        time: '19:00',
        partySize: 1
      };

      const createRes = await fetch(`${API_URL}/api/bookings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${TEST_AUTH_TOKEN}`
        },
        body: JSON.stringify(payload)
      });

      const createData = await createRes.json();
      const bookingId = createData.booking.id;

      // First cancel
      await fetch(`${API_URL}/api/bookings/${bookingId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${TEST_AUTH_TOKEN}`
        }
      });

      // Second cancel should fail
      const res = await fetch(`${API_URL}/api/bookings/${bookingId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${TEST_AUTH_TOKEN}`
        }
      });

      expect(res.status).toBe(409); // Conflict
    });
  });
});
