import { z } from 'zod';

// POST /auth/bootstrap — strict: only the Supabase access token, nothing else.
export const BootstrapSchema = z.object({
    access_token: z.string().min(1, 'Access token required'),
}).strict();

export type BootstrapInput = z.infer<typeof BootstrapSchema>;
