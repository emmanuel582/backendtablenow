import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { supabase } from '../lib/supabase';

export interface AuthRequest extends Request {
    user?: {
        userId: string;
        email: string;
        restaurantId: string;
    };
}

export const authenticateToken = async (req: AuthRequest, res: Response, next: NextFunction) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    try {
        // Verify Supabase JWT using the public key
        const decoded = jwt.decode(token, { complete: true }) as any;

        if (!decoded) {
            return res.status(403).json({ error: 'Invalid token format' });
        }

        // Get the Supabase user using the token
        const { data: { user: supabaseUser }, error: authError } = await supabase.auth.getUser(token);

        if (authError || !supabaseUser) {
            return res.status(403).json({ error: 'Invalid or expired token' });
        }

        // Find restaurant linked to this Supabase user
        const { data: restaurant, error: restaurantError } = await supabase
            .from('restaurants')
            .select('id')
            .eq('supabase_user_id', supabaseUser.id)
            .single();

        if (restaurantError || !restaurant) {
            return res.status(403).json({ error: 'Restaurant not found for user' });
        }

        // Inject user info into request
        req.user = {
            userId: supabaseUser.id,
            email: supabaseUser.email || '',
            restaurantId: restaurant.id,
        };

        next();
    } catch (error) {
        console.error('Auth error:', error);
        return res.status(403).json({ error: 'Invalid or expired token' });
    }
};
