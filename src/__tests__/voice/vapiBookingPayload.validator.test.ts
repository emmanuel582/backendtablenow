// ============================================
// Critical test: validateBookingPayload() MUST reject any payload that would
// otherwise be promoted to a 'confirmed' VoiceSessionState slot in VAPI's
// POST /create-booking endpoint. Without this gate, raw VAPI input could
// bypass conversation-level reliability guards.
// ============================================

import { validateBookingPayload } from '../../services/voice/vapiBookingPayload.validator';

function validPayload() {
    return {
        restaurantId: 'rest-001',
        date: '2026-05-24',
        time: '20:00',
        covers: 4,
        firstName: 'Karim',
        lastName: 'Dubois',
        guestPhone: '+33612345678',
        guestEmail: 'karim@example.com',
    };
}

describe('validateBookingPayload — defensive guard against premature/incomplete VAPI calls', () => {
    it('accepts a fully-formed payload and returns normalized data', () => {
        const result = validateBookingPayload(validPayload());
        expect(result.valid).toBe(true);
        if (result.valid) {
            expect(result.data.firstName).toBe('Karim');
            expect(result.data.covers).toBe(4);
            expect(result.data.guestEmail).toBe('karim@example.com');
        }
    });

    it('accepts payload without optional email', () => {
        const p = { ...validPayload(), guestEmail: '' };
        const result = validateBookingPayload(p);
        expect(result.valid).toBe(true);
        if (result.valid) expect(result.data.guestEmail).toBeNull();
    });

    it('trims whitespace from string fields before validating', () => {
        const result = validateBookingPayload({
            ...validPayload(),
            firstName: '  Karim  ',
            lastName: '  Dubois  ',
            guestPhone: ' +33612345678 ',
        });
        expect(result.valid).toBe(true);
        if (result.valid) {
            expect(result.data.firstName).toBe('Karim');
            expect(result.data.lastName).toBe('Dubois');
            expect(result.data.guestPhone).toBe('+33612345678');
        }
    });

    describe('missing fields', () => {
        it.each([
            ['restaurantId', 'restaurant_id'],
            ['date', 'date'],
            ['time', 'time'],
            ['covers', 'covers'],
            ['firstName', 'first_name'],
            ['lastName', 'last_name'],
            ['guestPhone', 'phone'],
        ])('reports %s as missing when empty string', (field, expectedKey) => {
            const p = { ...validPayload(), [field]: '' };
            const result = validateBookingPayload(p);
            expect(result.valid).toBe(false);
            if (!result.valid) {
                expect(result.missing).toContain(expectedKey);
            }
        });

        it.each([
            ['restaurantId', 'restaurant_id'],
            ['date', 'date'],
            ['time', 'time'],
            ['covers', 'covers'],
            ['firstName', 'first_name'],
            ['lastName', 'last_name'],
            ['guestPhone', 'phone'],
        ])('reports %s as missing when null', (field, expectedKey) => {
            const p = { ...validPayload(), [field]: null };
            const result = validateBookingPayload(p);
            expect(result.valid).toBe(false);
            if (!result.valid) {
                expect(result.missing).toContain(expectedKey);
            }
        });

        it('reports multiple missing fields at once', () => {
            const result = validateBookingPayload({
                restaurantId: '',
                date: '',
                time: '',
                covers: '',
                firstName: '',
                lastName: '',
                guestPhone: '',
            });
            expect(result.valid).toBe(false);
            if (!result.valid) {
                expect(result.missing).toEqual(expect.arrayContaining([
                    'restaurant_id', 'date', 'time', 'covers',
                    'first_name', 'last_name', 'phone',
                ]));
            }
        });
    });

    describe('invalid fields (present but malformed)', () => {
        it('rejects date with wrong format', () => {
            const result = validateBookingPayload({ ...validPayload(), date: '24/05/2026' });
            expect(result.valid).toBe(false);
            if (!result.valid) expect(result.invalid).toContain('date');
        });

        it('rejects nonexistent calendar date (Feb 30)', () => {
            const result = validateBookingPayload({ ...validPayload(), date: '2026-02-30' });
            expect(result.valid).toBe(false);
            if (!result.valid) expect(result.invalid).toContain('date');
        });

        it('rejects time with wrong format', () => {
            const result = validateBookingPayload({ ...validPayload(), time: '8pm' });
            expect(result.valid).toBe(false);
            if (!result.valid) expect(result.invalid).toContain('time');
        });

        it('rejects time out of 24h range', () => {
            const result = validateBookingPayload({ ...validPayload(), time: '25:00' });
            expect(result.valid).toBe(false);
            if (!result.valid) expect(result.invalid).toContain('time');
        });

        it('rejects covers = 0', () => {
            const result = validateBookingPayload({ ...validPayload(), covers: 0 });
            expect(result.valid).toBe(false);
            if (!result.valid) expect(result.invalid).toContain('covers');
        });

        it('rejects covers > 50', () => {
            const result = validateBookingPayload({ ...validPayload(), covers: 100 });
            expect(result.valid).toBe(false);
            if (!result.valid) expect(result.invalid).toContain('covers');
        });

        it('rejects negative covers', () => {
            const result = validateBookingPayload({ ...validPayload(), covers: -2 });
            expect(result.valid).toBe(false);
            if (!result.valid) expect(result.invalid).toContain('covers');
        });

        it('rejects phone shorter than 6 digits', () => {
            const result = validateBookingPayload({ ...validPayload(), guestPhone: '12345' });
            expect(result.valid).toBe(false);
            if (!result.valid) expect(result.invalid).toContain('phone');
        });

        it('rejects whitespace-only firstName as invalid (not missing)', () => {
            const result = validateBookingPayload({ ...validPayload(), firstName: '   ' });
            expect(result.valid).toBe(false);
            if (!result.valid) expect(result.invalid).toContain('first_name');
        });

        it('rejects malformed email when provided', () => {
            const result = validateBookingPayload({ ...validPayload(), guestEmail: 'not-an-email' });
            expect(result.valid).toBe(false);
            if (!result.valid) expect(result.invalid).toContain('email');
        });
    });

    describe('message content', () => {
        it('returns French message listing missing fields', () => {
            const result = validateBookingPayload({
                ...validPayload(),
                date: '',
                time: '',
            });
            expect(result.valid).toBe(false);
            if (!result.valid) {
                expect(result.message).toMatch(/champs manquants/);
                expect(result.message).toMatch(/date/);
                expect(result.message).toMatch(/time/);
            }
        });

        it('returns French message listing invalid fields', () => {
            const result = validateBookingPayload({
                ...validPayload(),
                date: '99-99-99',
                covers: 0,
            });
            expect(result.valid).toBe(false);
            if (!result.valid) {
                expect(result.message).toMatch(/champs invalides/);
            }
        });
    });
});
