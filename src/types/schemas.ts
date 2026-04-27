import { z } from 'zod';

// ─── Primitives ───────────────────────────────────────────────────────────────

export const UUIDSchema = z.string().uuid();
export const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');
export const TimeSchema = z.string().regex(/^\d{2}:\d{2}$/, 'Time must be HH:MM');
export const PhoneSchema = z.string().min(6).max(20);

// ─── Booking ──────────────────────────────────────────────────────────────────

// Langues supportées par la plate-forme (templates emails, UI, prompts VAPI).
export const LanguageSchema = z.enum(['fr', 'en']);

export const CreateBookingSchema = z.object({
    restaurant_id: UUIDSchema,
    date:          DateSchema,
    time:          TimeSchema,
    covers:        z.number().int().min(1).max(50),
    first_name:    z.string().min(1).max(100).trim(),
    last_name:     z.string().min(1).max(100).trim(),
    phone:         PhoneSchema.optional(),
    email:         z.string().email().optional(),
    special_requests: z.string().max(500).optional(),
    idempotency_key:  z.string().max(128).optional(),  // Prevents duplicate bookings on VAPI retry
    language:      LanguageSchema.optional()           // Langue capturée côté caller (VAPI ou form public)
});

export const ManualCreateBookingSchema = z.object({
    guestName:       z.string().min(1).max(200).trim(),
    guestEmail:      z.string().email(),
    guestPhone:      PhoneSchema.optional(),
    date:            DateSchema,
    time:            TimeSchema,
    partySize:       z.number().int().min(1).max(50),
    specialRequests: z.string().max(500).optional(),
    language:        LanguageSchema.optional()         // Langue du client (formulaire ou défaut restaurant)
});

export const UpdateRestaurantLanguageSchema = z.object({
    language: LanguageSchema
});

export const UpdateBookingSchema = z.object({
    status:          z.enum(['confirmed', 'cancelled', 'completed', 'no_show']).optional(),
    booking_date:    DateSchema.optional(),
    booking_time:    TimeSchema.optional(),
    party_size:      z.number().int().min(1).max(50).optional(),
    guest_name:      z.string().min(1).max(200).trim().optional(),
    guest_email:     z.string().email().optional(),
    guest_phone:     PhoneSchema.optional(),
    special_requests: z.string().max(500).optional()
});

export const BookingQuerySchema = z.object({
    status: z.enum(['confirmed', 'cancelled', 'completed', 'no_show']).optional(),
    date:   DateSchema.optional(),
    limit:  z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0)
});

// ─── Availability ─────────────────────────────────────────────────────────────

export const CheckAvailabilitySchema = z.object({
    restaurant_id: z.string().min(1),   // Accepts UUID or slug
    date:          DateSchema,
    time:          TimeSchema,
    covers:        z.coerce.number().int().min(1).max(50)
});

// ─── VAPI Webhook ─────────────────────────────────────────────────────────────

export const VapiToolCallSchema = z.object({
    id:       z.string(),
    type:     z.literal('function').optional(),
    function: z.object({
        name:      z.string(),
        arguments: z.union([z.string(), z.record(z.unknown())])
    }).optional(),
    // Legacy formats
    name:       z.string().optional(),
    parameters: z.record(z.unknown()).optional()
});

// ─── Types ────────────────────────────────────────────────────────────────────

export type CreateBookingInput    = z.infer<typeof CreateBookingSchema>;
export type ManualCreateBookingInput = z.infer<typeof ManualCreateBookingSchema>;
export type UpdateBookingInput    = z.infer<typeof UpdateBookingSchema>;
export type BookingQuery          = z.infer<typeof BookingQuerySchema>;
export type CheckAvailabilityInput = z.infer<typeof CheckAvailabilitySchema>;
export type Language               = z.infer<typeof LanguageSchema>;
export type UpdateRestaurantLanguageInput = z.infer<typeof UpdateRestaurantLanguageSchema>;
