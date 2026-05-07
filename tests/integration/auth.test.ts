import { describe, it, expect } from '@jest/globals';

/**
 * Integration tests for auth flow
 * Tests: validation, login, registration, email verification
 * Run: npm test tests/integration/auth.test.ts
 */

const API_URL = process.env.BACKEND_URL || 'http://localhost:5000';

describe('Auth Validation Tests', () => {
  // ─── Test 1: Register validation ────────────────────────────────────────
  describe('POST /api/auth/register (validation)', () => {
    it('should reject invalid email', async () => {
      const res = await fetch(`${API_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'invalid-email',
          password: 'Password123!',
          restaurantName: 'Test Restaurant',
          ownerName: 'Test Owner'
        })
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject short password', async () => {
      const res = await fetch(`${API_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'short', // Less than 8 chars
          restaurantName: 'Test Restaurant',
          ownerName: 'Test Owner'
        })
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject missing required fields', async () => {
      const res = await fetch(`${API_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com'
          // missing password, restaurantName, ownerName
        })
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('should accept valid registration data', async () => {
      const res = await fetch(`${API_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: `test-${Date.now()}@example.com`,
          password: 'ValidPassword123!',
          restaurantName: 'Test Restaurant',
          ownerName: 'Test Owner',
          phone: '+33612345678',
          address: '123 Main St'
        })
      });

      // 201 (created) or 409 (duplicate email)
      expect([201, 409]).toContain(res.status);
    });
  });

  // ─── Test 2: Login validation ────────────────────────────────────────────
  describe('POST /api/auth/login (validation)', () => {
    it('should reject invalid email', async () => {
      const res = await fetch(`${API_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'invalid-email',
          password: 'SomePassword123'
        })
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject missing password', async () => {
      const res = await fetch(`${API_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com'
          // missing password
        })
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject invalid credentials', async () => {
      const res = await fetch(`${API_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'nonexistent@example.com',
          password: 'WrongPassword123'
        })
      });

      expect(res.status).toBe(401);
    });
  });

  // ─── Test 3: Email verification validation ─────────────────────────────
  describe('POST /api/auth/verify-email (validation)', () => {
    it('should reject missing token', async () => {
      const res = await fetch(`${API_URL}/api/auth/verify-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject empty token', async () => {
      const res = await fetch(`${API_URL}/api/auth/verify-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: ''
        })
      });

      expect(res.status).toBe(400);
    });

    it('should reject invalid token', async () => {
      const res = await fetch(`${API_URL}/api/auth/verify-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: 'invalid-token-12345'
        })
      });

      expect(res.status).toBe(404);
    });
  });

  // ─── Test 4: Google OAuth validation ────────────────────────────────────
  describe('POST /api/auth/google/supabase (validation)', () => {
    it('should reject missing access_token', async () => {
      const res = await fetch(`${API_URL}/api/auth/google/supabase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject empty token', async () => {
      const res = await fetch(`${API_URL}/api/auth/google/supabase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          access_token: ''
        })
      });

      expect(res.status).toBe(400);
    });

    it('should reject invalid token', async () => {
      const res = await fetch(`${API_URL}/api/auth/google/supabase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          access_token: 'invalid-token'
        })
      });

      expect(res.status).toBe(401);
    });
  });

  // ─── Test 5: Error response format ──────────────────────────────────────
  describe('Error Response Format', () => {
    it('validation errors should include correlationId', async () => {
      const res = await fetch(`${API_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'invalid'
        })
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(data.error.message).toBeDefined();
      expect(data.error.correlationId).toBeDefined();
    });

    it('validation errors should list all field errors', async () => {
      const res = await fetch(`${API_URL}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'invalid-email',
          password: 'short'
        })
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.details).toBeDefined();
      expect(Array.isArray(data.error.details)).toBe(true);
      expect(data.error.details.length).toBeGreaterThan(0);
    });
  });
});
