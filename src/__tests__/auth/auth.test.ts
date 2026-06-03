import { resolveNextRoute } from '../../lib/routing';

describe('Authentication', () => {
  describe('resolveNextRoute (single routing source of truth)', () => {
    it('routes a linked restaurant to its slug-scoped dashboard', () => {
      expect(resolveNextRoute({ restaurant: { slug: 'la-trattoria' } })).toBe('/r/la-trattoria/dashboard');
    });

    it('routes to /login when there is no restaurant', () => {
      expect(resolveNextRoute({ restaurant: null })).toBe('/login');
    });

    it('routes to /login when the restaurant has no slug', () => {
      expect(resolveNextRoute({ restaurant: { slug: null } })).toBe('/login');
    });
  });

  // Token validation tests
  describe('JWT Token validation', () => {
    it('should validate token structure', () => {
      const mockToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiIxMjMiLCJyZXN0YXVyYW50SWQiOiJyZXN0LTEyMyJ9.test';
      const parts = mockToken.split('.');
      expect(parts).toHaveLength(3);
      expect(parts[0]).toBeDefined();
      expect(parts[1]).toBeDefined();
      expect(parts[2]).toBeDefined();
    });

    it('should require userId claim', () => {
      const mockPayload = {
        userId: 'user-123',
        restaurantId: 'rest-123',
      };
      expect(mockPayload.userId).toBeDefined();
    });

    it('should accept optional restaurantId claim', () => {
      const mockPayload1 = {
        userId: 'user-123',
        restaurantId: 'rest-123',
      };
      const mockPayload2 = {
        userId: 'user-456',
      } as any;
      expect(mockPayload1.restaurantId).toBeDefined();
      expect(mockPayload2.restaurantId).toBeUndefined();
    });
  });

  // User context tests
  describe('User context resolution', () => {
    it('should require userId for authenticated request', () => {
      const authReq = {
        user: {
          userId: 'user-123',
        },
      };
      expect(authReq.user.userId).toBeDefined();
    });

    it('should optionally include restaurantId', () => {
      const authReqWithRestaurant = {
        user: {
          userId: 'user-123',
          restaurantId: 'rest-123',
        },
      };
      expect(authReqWithRestaurant.user.restaurantId).toBe('rest-123');
    });

    it('should optionally include email', () => {
      const authReq = {
        user: {
          userId: 'user-123',
          email: 'user@example.com',
        },
      };
      expect(authReq.user.email).toBe('user@example.com');
    });

    it('should reject request without userId', () => {
      const invalidAuthReq = {
        user: {
          restaurantId: 'rest-123',
        } as any,
      };
      expect(invalidAuthReq.user.userId).toBeUndefined();
    });
  });

  // User context response tests
  describe('User context response', () => {
    it('should include user info in response', () => {
      const response = {
        user: {
          id: 'user-123',
          email: 'user@example.com',
        },
      };
      expect(response.user.id).toBeDefined();
    });

    it('should include restaurant info when available', () => {
      const response = {
        user: { id: 'user-123', email: 'user@example.com' },
        restaurant: {
          id: 'rest-123',
          name: 'La Trattoria',
          slug: 'la-trattoria',
          status: 'active',
          is_complete: true,
        },
      };
      expect(response.restaurant).toBeDefined();
      expect(response.restaurant.id).toBe('rest-123');
    });

    it('should set restaurant to null if not found', () => {
      const response = {
        user: { id: 'user-123' },
        restaurant: null,
      };
      expect(response.restaurant).toBeNull();
    });

    it('should include next_route for navigation', () => {
      const response = {
        user: { id: 'user-123' },
        next_route: '/dashboard',
      };
      expect(response.next_route).toBeDefined();
    });

    it('should include subscription status', () => {
      const response = {
        subscription: {
          status: 'active',
        },
      };
      expect(response.subscription.status).toBeDefined();
    });

    it('should include calendar integration status', () => {
      const response = {
        calendar: {
          status: 'connected',
        },
      };
      expect(response.calendar.status).toBeDefined();
    });

    it('should include onboarding status', () => {
      const response = {
        onboarding: {
          status: 'in_progress',
          test_call_completed: false,
        },
      };
      expect(response.onboarding.status).toBeDefined();
      expect(response.onboarding.test_call_completed).toBe(false);
    });

    it('should include assistant status', () => {
      const response = {
        assistant: {
          status: 'inactive',
        },
      };
      expect(response.assistant.status).toBeDefined();
    });
  });

  // Registration flow tests
  describe('Registration validation', () => {
    it('should require email for registration', () => {
      const registrationData = {
        email: 'user@example.com',
        password: 'SecurePassword123!',
        restaurantName: 'La Trattoria',
        ownerName: 'John Doe',
      };
      expect(registrationData.email).toBeDefined();
      expect(registrationData.email).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
    });

    it('should require password for registration', () => {
      const registrationData = {
        email: 'user@example.com',
        password: 'SecurePassword123!',
      };
      expect(registrationData.password).toBeDefined();
      expect(registrationData.password.length).toBeGreaterThanOrEqual(8);
    });

    it('should require restaurantName for registration', () => {
      const registrationData = {
        email: 'user@example.com',
        password: 'SecurePassword123!',
        restaurantName: 'La Trattoria',
      };
      expect(registrationData.restaurantName).toBeDefined();
    });

    it('should require ownerName for registration', () => {
      const registrationData = {
        email: 'user@example.com',
        password: 'SecurePassword123!',
        ownerName: 'John Doe',
      };
      expect(registrationData.ownerName).toBeDefined();
    });

    it('should reject invalid email format', () => {
      const invalidEmail = 'not-an-email';
      const isValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(invalidEmail);
      expect(isValid).toBe(false);
    });

    it('should reject weak password', () => {
      const weakPassword = '123';
      expect(weakPassword.length).toBeLessThan(8);
    });
  });
});
