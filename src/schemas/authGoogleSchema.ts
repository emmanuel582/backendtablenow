/**
 * Google Authentication Schema
 * Validates POST /api/auth/google/supabase payloads
 */

import { z } from 'zod';

export const AuthGoogleSchema = z.object({
    access_token: z.string().min(1, 'Access token required'),
    state: z.string().optional(),
    nonce: z.string().optional(),
    code_challenge: z.string().optional(),
    code_challenge_method: z.string().optional()
}).strict(); // Reject unknown fields

export const GoogleTokenResponseSchema = z.object({
    access_token: z.string(),
    refresh_token: z.string().optional(),
    expires_in: z.number().optional(),
    token_type: z.string().optional(),
    scope: z.string().optional(),
    id_token: z.string().optional()
});

export const AuthGoogleCallbackSchema = z.object({
    code: z.string().min(1, 'Authorization code required'),
    state: z.string().optional(),
    error: z.string().optional(),
    error_description: z.string().optional()
}).strict();

export type AuthGoogleInput = z.infer<typeof AuthGoogleSchema>;
export type GoogleTokenResponse = z.infer<typeof GoogleTokenResponseSchema>;
export type AuthGoogleCallback = z.infer<typeof AuthGoogleCallbackSchema>;
