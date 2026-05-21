import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { supabase } from '../config/supabase';
import logger from '../lib/logger';

export interface AuthRequest extends Request {
    user?: {
        userId: string;
        email: string;
        restaurantId: string;
    };
    restaurant?: any;
}

export const authenticateToken = async (req: AuthRequest, res: Response, next: NextFunction) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    try {
        // Verify backend JWT (issued by /api/auth/google/supabase)
        const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;

        if (!decoded.restaurantId) {
            return res.status(403).json({ error: 'Invalid token: missing restaurantId' });
        }

        // Fetch restaurant from DB
        const { data: restaurant, error: dbError } = await supabase
            .from('restaurants')
            .select('*')
            .eq('id', decoded.restaurantId)
            .single();

        if (dbError || !restaurant) {
            return res.status(403).json({ error: 'Restaurant not found' });
        }

        // Inject user info into request
        req.user = {
            userId: decoded.id,
            email: decoded.email,
            restaurantId: restaurant.id,
        };
        req.restaurant = restaurant;

        next();
    } catch (error: any) {
        if (error.name === 'JsonWebTokenError') {
            return res.status(403).json({ error: 'Invalid token' });
        }
        if (error.name === 'TokenExpiredError') {
            return res.status(403).json({ error: 'Token expired' });
        }
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
