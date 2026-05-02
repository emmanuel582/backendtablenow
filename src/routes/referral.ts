import { Router, Response } from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import supabase from '../config/supabase';

const router = Router();
router.use(authenticateToken);

router.get('/stats', async (req: AuthRequest, res: Response, next) => {
    try {
        const restaurantId = req.user!.restaurantId;
        const { data, error } = await supabase
            .from('v_referral_stats')
            .select('*')
            .eq('restaurant_id', restaurantId)
            .single();
        if (error) throw error;
        res.json(data);
    } catch (err) { next(err); }
});

router.get('/list', async (req: AuthRequest, res: Response, next) => {
    try {
        const restaurantId = req.user!.restaurantId;
        const { data, error } = await supabase
            .from('referrals')
            .select('*, referred:referred_id(name, plan, created_at)')
            .eq('referrer_id', restaurantId)
            .order('created_at', { ascending: false });
        if (error) throw error;
        res.json({ referrals: data || [] });
    } catch (err) { next(err); }
});

export default router;
