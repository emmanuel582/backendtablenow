import { Router, Response } from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import supabase from '../config/supabase';
import calendarService from '../services/calendar.service';

const router = Router();

/**
 * Handle Google OAuth callback (Redirect from Google)
 * This must be public as Google doesn't allow auth headers in redirects
 */
router.get('/callback', (req: any, res: Response) => {
    const { code, error } = req.query;
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

    if (error) {
        return res.redirect(`${frontendUrl}/settings?error=${error}`);
    }

    if (!code) {
        return res.redirect(`${frontendUrl}/settings?error=no_code`);
    }

    // Redirect to frontend with code, where it will be exchanged via POST
    res.redirect(`${frontendUrl}/settings?code=${code}`);
});

router.use(authenticateToken);

/**
 * Get Google Calendar authorization URL
 */
router.get('/auth-url', (req: AuthRequest, res: Response) => {
    try {
        const authUrl = calendarService.getAuthUrl();
        res.json({ authUrl });
    } catch (error: any) {
        console.error('Get auth URL error:', error);
        res.status(500).json({ error: 'Failed to generate auth URL' });
    }
});

/**
 * OAuth callback - exchange code for tokens
 */
router.post('/callback', async (req: AuthRequest, res: Response) => {
    try {
        const { code } = req.body;
        const restaurantId = req.user!.restaurantId;

        if (!code) {
            return res.status(400).json({ error: 'Authorization code required' });
        }

        // Exchange code for tokens
        const tokens = await calendarService.getTokensFromCode(code);

        // Store tokens in database
        await supabase
            .from('restaurants')
            .update({ google_calendar_tokens: JSON.stringify(tokens) })
            .eq('id', restaurantId);

        res.json({ message: 'Calendar connected successfully' });
    } catch (error: any) {
        console.error('Calendar callback error:', error);
        res.status(500).json({ error: 'Failed to connect calendar' });
    }
});

/**
 * Disconnect calendar
 */
router.post('/disconnect', async (req: AuthRequest, res: Response) => {
    try {
        const restaurantId = req.user!.restaurantId;

        await supabase
            .from('restaurants')
            .update({ google_calendar_tokens: null })
            .eq('id', restaurantId);

        res.json({ message: 'Calendar disconnected successfully' });
    } catch (error: any) {
        console.error('Calendar disconnect error:', error);
        res.status(500).json({ error: 'Failed to disconnect calendar' });
    }
});

export default router;
