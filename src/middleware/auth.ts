import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { supabase, getUserFromToken } from '../config/supabase';
import logger from '../lib/logger';

export interface AuthRequest extends Request {
    user?: {
        userId: string;        // auth.users.id (Supabase Auth)
        email: string;
        restaurantId: string;
    };
    restaurant?: any;
}

/**
 * Unified Supabase auth: the bearer is a Supabase Auth access_token. We validate
 * the token, then resolve the `restaurants` row via supabase_user_id (auto-linking
 * by email if a row exists but isn't linked to this Supabase user yet).
 *
 * This is the known-good scheme: any valid session resolves a restaurant, so the
 * frontend never lands on "Restaurant Not Linked" because of a missing/expired
 * secondary backend token.
 */
export const authenticateToken = async (req: AuthRequest, res: Response, next: NextFunction) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    try {
        const authUser = await getUserFromToken(token);
        if (!authUser) {
            return res.status(403).json({ error: 'Invalid token' });
        }

        // 1) Resolve by supabase_user_id
        let { data: restaurant } = await supabase
            .from('restaurants')
            .select('*')
            .eq('supabase_user_id', authUser.id)
            .maybeSingle();

        // 2) Fallback: existing row by email -> link it to this Supabase user
        if (!restaurant && authUser.email) {
            const { data: byEmail } = await supabase
                .from('restaurants')
                .select('*')
                .eq('email', authUser.email)
                .maybeSingle();
            if (byEmail) {
                const { data: linked } = await supabase
                    .from('restaurants')
                    .update({ supabase_user_id: authUser.id })
                    .eq('id', byEmail.id)
                    .select()
                    .single();
                restaurant = linked || byEmail;
            }
        }

        if (!restaurant) {
            return res.status(403).json({ error: 'Restaurant not found', code: 'NO_RESTAURANT' });
        }

        req.user = {
            userId: authUser.id,
            email: authUser.email || restaurant.email,
            restaurantId: restaurant.id,
        };
        req.restaurant = restaurant;

        next();
    } catch (error: any) {
        logger.error({ err: error?.message }, 'Auth middleware error');
        return res.status(403).json({ error: 'Authentication failed' });
    }
};

/**
 * Middleware to validate BCC email endpoint secret header
 * Prevents attackers from faking PMS notifications
 * SECURITY: KEEP PUBLIC CONTRACT - X-BCC-Secret header required
 */
export const validateBCCSecret = (req: Request, res: Response, next: NextFunction) => {
    const secret = process.env.BCC_SECRET;
    const headerSecret = req.headers['x-bcc-secret'] as string;

    if (!secret) {
        logger.error({ action: 'bcc_validation' }, 'BCC_SECRET not configured');
        return res.status(500).json({ error: 'Server misconfiguration' });
    }

    if (!headerSecret) {
        logger.warn({ action: 'bcc_validation' }, 'BCC endpoint request missing X-BCC-Secret header');
        return res.status(401).json({ error: 'Unauthorized: Missing X-BCC-Secret header' });
    }

    try {
        // Use timingSafeEqual to prevent timing attacks
        const secretBuffer = Buffer.from(secret, 'utf8');
        const headerBuffer = Buffer.from(headerSecret, 'utf8');

        if (secretBuffer.length !== headerBuffer.length) {
            logger.warn({ action: 'bcc_validation' }, 'BCC secret length mismatch - rejecting request');
            return res.status(401).json({ error: 'Unauthorized: Invalid secret' });
        }

        if (!crypto.timingSafeEqual(secretBuffer, headerBuffer)) {
            logger.warn({ action: 'bcc_validation' }, 'BCC secret verification failed - rejecting request');
            return res.status(401).json({ error: 'Unauthorized: Invalid secret' });
        }

        // Secret valid, proceed
        next();
    } catch (err: any) {
        logger.error({ action: 'bcc_validation', error: err.message }, 'BCC secret validation error');
        return res.status(401).json({ error: 'Unauthorized' });
    }
};
