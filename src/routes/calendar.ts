import { Router, Response } from 'express';
import crypto from 'crypto';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import supabase from '../config/supabase';
import calendarService from '../services/calendar.service';
import { config } from '../lib/config';

const router = Router();

/**
 * Handle Google OAuth callback (Redirect from Google)
 * This must be public as Google doesn't allow auth headers in redirects
 */
router.get('/callback', (req: any, res: Response) => {
    const { code, error, state } = req.query;
    const frontendUrl = config.frontendUrl;
    const returnTo = req.cookies?.oauth_return_to ?? 'settings';
    const redirectPath = returnTo === 'setup' ? '/setup/calendar' : '/settings';

    if (error) {
        return res.redirect(`${frontendUrl}${redirectPath}?error=${error}`);
    }

    if (!code) {
        return res.redirect(`${frontendUrl}${redirectPath}?error=no_code`);
    }

    // Verify CSRF state token
    const cookieState = req.cookies?.oauth_state;
    if (!state || !cookieState || state !== cookieState) {
        console.error('OAuth state mismatch — possible CSRF', { state, cookieState });
        return res.redirect(`${frontendUrl}${redirectPath}?error=state_mismatch`);
    }

    // Clear the state and return_to cookies
    res.clearCookie('oauth_state');
    res.clearCookie('oauth_return_to');

    // Redirect to frontend with code, where it will be exchanged via POST
    res.redirect(`${frontendUrl}${redirectPath}?code=${code}`);
});

router.use(authenticateToken);

/**
 * Get Google Calendar authorization URL
 */
router.get('/auth-url', (req: AuthRequest, res: Response) => {
    try {
        const returnTo = req.query.return_to === 'setup' ? 'setup' : 'settings';
        const state = crypto.randomBytes(32).toString('hex');

        // Store state and return_to in httpOnly cookies (expires in 10 min)
        res.cookie('oauth_state', state, {
            httpOnly: true,
            secure: true,
            sameSite: 'lax',
            maxAge: 10 * 60 * 1000
        });
        res.cookie('oauth_return_to', returnTo, {
            httpOnly: true,
            secure: true,
            sameSite: 'lax',
            maxAge: 10 * 60 * 1000
        });

        const authUrl = calendarService.getAuthUrl(state);
        console.log('Generated Google Auth URL with state');
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
            .update({
                google_calendar_tokens: JSON.stringify(tokens),
                calendar_status: 'connected'
            })
            .eq('id', restaurantId);

        res.json({ message: 'Calendar connected successfully', calendar_status: 'connected' });
    } catch (error: any) {
        console.error('Calendar callback error:', error);
        res.status(500).json({ error: 'Failed to connect calendar' });
    }
});

/**
 * Skip calendar setup during onboarding
 */
router.post('/skip', async (req: AuthRequest, res: Response) => {
    try {
        const restaurantId = req.user!.restaurantId;

        await supabase
            .from('restaurants')
            .update({ calendar_status: 'skipped' })
            .eq('id', restaurantId);

        res.json({ success: true, calendar_status: 'skipped' });
    } catch (error: any) {
        console.error('Calendar skip error:', error);
        res.status(500).json({ error: 'Failed to skip calendar setup' });
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
            .update({
                google_calendar_tokens: null,
                calendar_status: 'pending'
            })
            .eq('id', restaurantId);

        res.json({ message: 'Calendar disconnected successfully', calendar_status: 'pending' });
    } catch (error: any) {
        console.error('Calendar disconnect error:', error);
        res.status(500).json({ error: 'Failed to disconnect calendar' });
    }
});

export default router;
