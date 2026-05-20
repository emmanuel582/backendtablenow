import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { supabase } from '../config/supabase';

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
