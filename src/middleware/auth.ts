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
        // Verify Supabase access token
        const { data: { user: supabaseUser }, error: authError } = await supabase.auth.getUser(token);

        if (authError || !supabaseUser) {
            return res.status(401).json({ error: 'Invalid or expired token' });
        }

        const supabaseUserId = supabaseUser.id;
        const userEmail = supabaseUser.email || '';

        // Find TableNow user by supabase_user_id or email
        let { data: tableNowUser, error: findError } = await supabase
            .from('users')
            .select('*')
            .eq('supabase_user_id', supabaseUserId)
            .single();

        // If not found by supabase_user_id, try by email
        if (!tableNowUser && findError?.code === 'PGRST116' && userEmail) {
            const { data: userByEmail } = await supabase
                .from('users')
                .select('*')
                .eq('email', userEmail)
                .single();
            tableNowUser = userByEmail;
        }

        // Link supabase_user_id if user exists but not yet linked
        if (tableNowUser && !tableNowUser.supabase_user_id) {
            await supabase
                .from('users')
                .update({ supabase_user_id: supabaseUserId })
                .eq('id', tableNowUser.id);
            tableNowUser.supabase_user_id = supabaseUserId;
        }

        // Inject user info — does NOT require a restaurant
        req.user = {
            userId: supabaseUserId,
            email: userEmail,
            restaurantId: tableNowUser?.restaurant_id || '',
        };

        // Try to find and attach restaurant if user exists and has a restaurant_id
        if (tableNowUser?.restaurant_id) {
            const { data: restaurant } = await supabase
                .from('restaurants')
                .select('*')
                .eq('id', tableNowUser.restaurant_id)
                .single();
            req.restaurant = restaurant || undefined;
        }

        next();
    } catch (error: any) {
        console.error('Auth error:', error);
        return res.status(401).json({ error: 'Authentication failed' });
    }
};
