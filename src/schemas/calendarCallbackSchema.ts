/**
 * Google Calendar OAuth Callback Validation Schema
 * Validates GET /api/calendar/callback payloads
 */

import { z } from 'zod';

export const CalendarCallbackSchema = z.object({
    code: z.string().optional(),
    state: z.string().optional(),
    error: z.string().optional(),
    error_description: z.string().optional()
}).strict(); // Reject unknown fields

// At least one of code or error must be present
export const ValidatedCalendarCallback = CalendarCallbackSchema.refine(
    (data) => !!data.code || !!data.error,
    { message: 'Either code or error must be present' }
);

export type CalendarCallbackInput = z.infer<typeof CalendarCallbackSchema>;
