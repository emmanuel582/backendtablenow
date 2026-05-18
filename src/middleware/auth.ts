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
        // Verify Supabase JWT
        const { data: { user: supabaseUser }, error: authError } = await supabase.auth.getUser(token);

        if (authError || !supabaseUser) {
            return res.status(403).json({ error: 'Invalid or expired token' });
        }

        let restaurant;

        // 1. Try to find restaurant by existing supabase_user_id link
        const { data: linkedRestaurant, error: linkedError } = await supabase
            .from('restaurants')
            .select('id')
            .eq('supabase_user_id', supabaseUser.id)
            .single();

        if (linkedRestaurant) {
            restaurant = linkedRestaurant;
        } else if (!linkedError || linkedError.code === 'PGRST116') {
            // PGRST116 = no rows found (normal case)
            // Only allow auto-link if email is verified
            if (!supabaseUser.email_confirmed_at) {
                return res.status(403).json({ error: 'Email must be verified to link restaurant' });
            }

            // Try to find unlinked restaurant by email match
            const userEmail = supabaseUser.email || '';

            const { data: emailMatchRestaurant, error: emailError } = await supabase
                .from('restaurants')
                .select('id')
                .or(`email.eq.${userEmail},confirmation_email.eq.${userEmail}`)
                .is('supabase_user_id', null)
                .single();

            if (emailMatchRestaurant) {
                // Auto-link: update this restaurant with the Supabase user_id
                const { error: updateError } = await supabase
                    .from('restaurants')
                    .update({ supabase_user_id: supabaseUser.id })
                    .eq('id', emailMatchRestaurant.id);

                if (!updateError) {
                    restaurant = emailMatchRestaurant;
                }
            }
        }

        if (!restaurant) {
            return res.status(403).json({ error: 'Restaurant not linked to Supabase user' });
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
