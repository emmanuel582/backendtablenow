import { Router, Response } from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import supabase from '../config/supabase';

const router = Router();
router.use(authenticateToken);

/**
 * Get dashboard statistics
 */
router.get('/stats', async (req: AuthRequest, res: Response) => {
    try {
        const restaurantId = req.user!.restaurantId;
        const { startDate, endDate } = req.query;

        // Get total bookings
        let bookingsQuery = supabase
            .from('bookings')
            .select('*', { count: 'exact' })
            .eq('restaurant_id', restaurantId)
            .order('booking_date', { ascending: false })
            .order('created_at', { ascending: false });

        if (startDate) bookingsQuery = bookingsQuery.gte('booking_date', startDate);
        if (endDate) bookingsQuery = bookingsQuery.lte('booking_date', endDate);

        const { data: bookings, count: totalBookings } = await bookingsQuery;

        // Get call logs
        let callsQuery = supabase
            .from('call_logs')
            .select('*', { count: 'exact' })
            .eq('restaurant_id', restaurantId)
            .order('created_at', { ascending: false });

        if (startDate) callsQuery = callsQuery.gte('created_at', startDate);
        if (endDate) callsQuery = callsQuery.lte('created_at', endDate);

        const { data: calls, count: totalCalls } = await callsQuery;

        // Calculate statistics
        const confirmedBookings = bookings?.filter(b => b.status === 'confirmed').length || 0;
        const cancelledBookings = bookings?.filter(b => b.status === 'cancelled').length || 0;
        const totalGuests = bookings?.reduce((sum, b) => sum + (b.party_size || 0), 0) || 0;
        const avgPartySize = totalBookings ? (totalGuests / totalBookings).toFixed(1) : 0;

        // Call statistics
        const successfulCalls = calls?.filter(c => c.status === 'completed').length || 0;
        const avgCallDuration = calls?.length
            ? (calls.reduce((sum, c) => sum + (c.duration || 0), 0) / calls.length).toFixed(0)
            : 0;

        // Booking sources
        const bookingsBySource = bookings?.reduce((acc: any, b) => {
            acc[b.source || 'unknown'] = (acc[b.source || 'unknown'] || 0) + 1;
            return acc;
        }, {});

        // Recent activity
        const recentBookings = bookings?.slice(0, 10) || [];
        const recentCalls = calls?.slice(0, 10) || [];

        res.json({
            bookings: {
                total: totalBookings,
                confirmed: confirmedBookings,
                cancelled: cancelledBookings,
                totalGuests,
                avgPartySize,
                bySource: bookingsBySource
            },
            calls: {
                total: totalCalls,
                successful: successfulCalls,
                avgDuration: avgCallDuration
            },
            recent: {
                bookings: recentBookings,
                calls: recentCalls
            }
        });
    } catch (error: any) {
        console.error('Dashboard stats error:', error);
        res.status(500).json({ error: 'Failed to fetch statistics' });
    }
});

/**
 * Get call logs
 */
router.get('/calls', async (req: AuthRequest, res: Response) => {
    try {
        const restaurantId = req.user!.restaurantId;
        const { limit = 50, offset = 0 } = req.query;

        const { data: calls, error, count } = await supabase
            .from('call_logs')
            .select('*', { count: 'exact' })
            .eq('restaurant_id', restaurantId)
            .order('created_at', { ascending: false })
            .range(Number(offset), Number(offset) + Number(limit) - 1);

        if (error) {
            return res.status(500).json({ error: 'Failed to fetch call logs' });
        }

        res.json({ calls, total: count, limit: Number(limit), offset: Number(offset) });
    } catch (error: any) {
        console.error('Get calls error:', error);
        res.status(500).json({ error: 'Failed to fetch call logs' });
    }
});

export default router;
