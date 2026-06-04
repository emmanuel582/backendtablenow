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
 * Supabase auth: validate token and resolve the user's restaurant.
 *
 * Responsibility: authentication only (validate token, resolve supabase_user_id → restaurant).
 * Do NOT create or link restaurants — that's /auth/bootstrap only.
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

        // Security: email must be confirmed in Supabase Auth
        if (!authUser.email_confirmed_at) {
            logger.warn(
                { userId: authUser.id, email: authUser.email },
                'Access denied: email not confirmed'
            );
            return res.status(403).json({ error: 'Email confirmation required', code: 'EMAIL_NOT_CONFIRMED' });
        }

        // Resolve restaurant by explicit link (supabase_user_id)
        // Linking happens ONLY in /auth/bootstrap, never here
        const { data: restaurant } = await supabase
            .from('restaurants')
            .select('*')
            .eq('supabase_user_id', authUser.id)
            .maybeSingle();

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
