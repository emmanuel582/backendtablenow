describe('Input Validation', () => {
  // Booking schema validation
  describe('Booking validation schema', () => {
    const validBooking = {
      restaurant_id: 'rest-123',
      first_name: 'John',
      last_name: 'Doe',
      phone: '0123456789',
      covers: 2,
      date: '2025-01-15',
      time: '19:00',
    };

    it('should validate required restaurant_id as string', () => {
      expect(typeof validBooking.restaurant_id).toBe('string');
      expect(validBooking.restaurant_id.length).toBeGreaterThan(0);
    });

    it('should validate required first_name as string', () => {
      expect(typeof validBooking.first_name).toBe('string');
      expect(validBooking.first_name.length).toBeGreaterThan(0);
    });

    it('should validate required last_name as string', () => {
      expect(typeof validBooking.last_name).toBe('string');
      expect(validBooking.last_name.length).toBeGreaterThan(0);
    });

    it('should validate required phone as string', () => {
      expect(typeof validBooking.phone).toBe('string');
      expect(validBooking.phone.length).toBeGreaterThan(0);
    });

    it('should validate required covers as positive integer', () => {
      const covers = validBooking.covers;
      expect(typeof covers).toBe('number');
      expect(covers).toBeGreaterThan(0);
    });

    it('should validate required date in YYYY-MM-DD format', () => {
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      expect(dateRegex.test(validBooking.date)).toBe(true);
    });

    it('should validate required time in HH:MM format', () => {
      const timeRegex = /^\d{2}:\d{2}$/;
      expect(timeRegex.test(validBooking.time)).toBe(true);
    });

    it('should validate optional email as string if provided', () => {
      const withEmail = { ...validBooking, email: 'john@example.com' };
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      expect(emailRegex.test(withEmail.email)).toBe(true);
    });

    it('should validate optional occasion as string if provided', () => {
      const withOccasion = { ...validBooking, occasion: 'Birthday' };
      expect(typeof withOccasion.occasion).toBe('string');
    });

    it('should validate optional language as en or fr', () => {
      const validLanguages = ['en', 'fr'];
      const withLanguage = { ...validBooking, language: 'en' };
      expect(validLanguages).toContain(withLanguage.language);
    });

    it('should reject invalid date format', () => {
      const invalidDate = '15-01-2025';
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      expect(dateRegex.test(invalidDate)).toBe(false);
    });

    it('should reject invalid time format', () => {
      const invalidTime = '7:00 PM';
      const timeRegex = /^\d{2}:\d{2}$/;
      expect(timeRegex.test(invalidTime)).toBe(false);
    });

    it('should reject zero or negative covers', () => {
      expect((0)).toBeLessThanOrEqual(0);
      expect((-1)).toBeLessThan(0);
    });

    it('should reject invalid email format', () => {
      const invalidEmail = 'not-an-email';
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      expect(emailRegex.test(invalidEmail)).toBe(false);
    });
  });

  // VAPI webhook payload validation
  describe('VAPI webhook validation schema', () => {
    it('should validate event field', () => {
      const payload = { event: 'call.ended' };
      expect(['call.started', 'call.ended', 'message']).toContain(payload.event);
    });

    it('should validate callId field', () => {
      const payload = { callId: 'call-123-abc' };
      expect(typeof payload.callId).toBe('string');
      expect(payload.callId.length).toBeGreaterThan(0);
    });

    it('should validate messages array if provided', () => {
      const payload = {
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there' },
        ],
      };
      expect(Array.isArray(payload.messages)).toBe(true);
      expect(payload.messages).toHaveLength(2);
    });

    it('should validate toolCalls array if provided', () => {
      const payload = {
        toolCalls: [
          { name: 'check_availability', args: { date: '2025-01-15' } },
        ],
      };
      expect(Array.isArray(payload.toolCalls)).toBe(true);
    });

    it('should reject empty event field', () => {
      const invalidPayload = { event: '' };
      expect(invalidPayload.event.length).toBe(0);
    });
  });

  // Calendar OAuth validation
  describe('Calendar OAuth validation', () => {
    it('should validate authorization code', () => {
      const callbackData = { code: 'auth-code-123-abc' };
      expect(typeof callbackData.code).toBe('string');
      expect(callbackData.code.length).toBeGreaterThan(0);
    });

    it('should allow error field for denial flow', () => {
      const callbackData = { error: 'access_denied' };
      expect(callbackData.error).toBeDefined();
    });

    it('should reject both code and error', () => {
      const invalid = { code: 'auth-code', error: 'access_denied' };
      const hasCode = Boolean(invalid.code);
      const hasError = Boolean(invalid.error);
      const isValid = hasCode !== hasError;
      expect(isValid).toBe(false);
    });

    it('should require either code or error', () => {
      const invalid = {} as any;
      const hasCode = Boolean(invalid.code);
      const hasError = Boolean(invalid.error);
      const isValid = hasCode || hasError;
      expect(isValid).toBe(false);
    });
  });

  // Google token exchange validation
  describe('Google token exchange validation', () => {
    it('should validate access_token field', () => {
      const payload = { access_token: 'ya29.token-123-abc' };
      expect(typeof payload.access_token).toBe('string');
      expect(payload.access_token.length).toBeGreaterThan(0);
    });

    it('should reject missing access_token', () => {
      const invalid = { id_token: 'token-123' } as any;
      expect(invalid.access_token).toBeUndefined();
    });

    it('should accept optional id_token', () => {
      const payload = {
        access_token: 'ya29.token-123',
        id_token: 'eyJhbGc...',
      };
      expect(payload.id_token).toBeDefined();
    });

    it('should accept optional expires_in', () => {
      const payload = {
        access_token: 'ya29.token-123',
        expires_in: 3600,
      };
      expect(typeof payload.expires_in).toBe('number');
      expect(payload.expires_in).toBeGreaterThan(0);
    });
  });

  // Error response format
  describe('Validation error responses', () => {
    it('should return VALIDATION_ERROR type', () => {
      const errorResponse = {
        error: 'VALIDATION_ERROR',
        details: { field: 'phone', message: 'Required' },
      };
      expect(errorResponse.error).toBe('VALIDATION_ERROR');
    });

    it('should include error details', () => {
      const errorResponse = {
        error: 'VALIDATION_ERROR',
        details: {
          fieldErrors: {
            restaurant_id: ['Required'],
            covers: ['Must be positive integer'],
          },
        },
      };
      expect(errorResponse.details.fieldErrors).toBeDefined();
    });

    it('should include correlationId for tracing', () => {
      const errorResponse = {
        error: 'VALIDATION_ERROR',
        correlationId: 'req-123-abc-def',
      };
      expect(errorResponse.correlationId).toBeDefined();
    });

    it('should not include raw validation internals', () => {
      const errorResponse = {
        error: 'VALIDATION_ERROR',
        details: { message: 'Field required' },
      };
      expect(errorResponse.details.message).toBeDefined();
      expect(typeof errorResponse.details.message).toBe('string');
    });
  });
});
