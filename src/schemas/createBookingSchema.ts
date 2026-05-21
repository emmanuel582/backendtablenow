/**
 * Booking Creation Validation Schema
 * Validates POST /api/bookings payloads
 */

import { z } from 'zod';

export const CreateBookingSchema = z.object({
    restaurant_id: z.string().uuid('Invalid restaurant ID'),
    guest_name: z.string().min(1, 'Guest name required').max(200, 'Guest name too long').trim(),
    guest_email: z.string().email('Invalid email').optional().or(z.literal('')),
    guest_phone: z.string().min(6, 'Phone too short').max(20, 'Phone too long').optional().or(z.literal('')),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
    time: z.string().regex(/^\d{2}:\d{2}$/, 'Time must be HH:MM'),
    covers: z.coerce.number().int('Party size must be integer').min(1, 'At least 1 guest').max(50, 'Max 50 guests'),
    special_requests: z.string().max(500, 'Special requests too long').optional().or(z.literal('')),
    source: z.enum(['dashboard', 'vapi', 'bcc', 'whatsapp'], { message: 'Invalid source' }),
    language: z.enum(['fr', 'en']).optional(),
    idempotency_key: z.string().max(128).optional()
}).strict(); // Reject unknown fields

export type CreateBookingInput = z.infer<typeof CreateBookingSchema>;
