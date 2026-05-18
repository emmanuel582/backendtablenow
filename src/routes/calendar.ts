import { Router, Response } from 'express';
import crypto from 'crypto';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import supabase from '../config/supabase';
import calendarService from '../services/calendar.service';
import { config } from '../lib/config';

const router = Router();

// Allowed return paths for open-redirect prevention
const ALLOWED_RETURN_PATHS = [
    '/setup',
    '/setup/calendar',
    '/setup/success',
    '/r/',
    '/dashboard',
    '/settings',
];

function isValidReturnPath(path: string): boolean {
    if (!path || !path.startsWith('/')) return false;
    if (path.includes('//') || path.includes('http')) return false;
    return ALLOWED_RETURN_PATHS.some(allowed =>
        path === allowed || path.startsWith(allowed + '/')
    );
}

/**
 * Handle Google OAuth callback (Redirect from Google)
 * This must be public as Google doesn't allow auth headers in redirects
 * Validates state, reads returnTo, clears cookies, redirects with code/error
 * Does NOT exchange tokens here — that happens on POST /callback (authenticated)
 */
router.get('/callback', (req: any, res: Response) => {
    const { code, error, state } = req.query;
    const cookieState = req.cookies?.oauth_state;
    const cookieReturnTo = req.cookies?.oauth_return_to;

    // Determine safe return path
    const returnTo = isValidReturnPath(cookieReturnTo) ? cookieReturnTo : '/settings';

    // Handle Google error response
    if (error) {
        res.clearCookie('oauth_state');
        res.clearCookie('oauth_return_to');
        return res.redirect(`${config.frontendUrl}${returnTo}?error=${encodeURIComponent(error)}`);
    }

    if (!code) {
        res.clearCookie('oauth_state');
        res.clearCookie('oauth_return_to');
        return res.redirect(`${config.frontendUrl}${returnTo}?error=no_code`);
    }

    // Verify CSRF state token
    if (!state || !cookieState || state !== cookieState) {
        console.error('OAuth state mismatch — possible CSRF', { state, cookieState });
        res.clearCookie('oauth_state');
        res.clearCookie('oauth_return_to');
        return res.redirect(`${config.frontendUrl}${returnTo}?error=invalid_state`);
    }

    // Clear both cookies
    res.clearCookie('oauth_state');
    res.clearCookie('oauth_return_to');

    // Redirect to frontend with code, where it will be exchanged via POST
    res.redirect(`${config.frontendUrl}${returnTo}?code=${code}`);
});

router.use(authenticateToken);

/**
 * Get Google Calendar authorization URL
 * Supports ?returnTo=<path>&context=setup|dashboard
 */
router.get('/auth-url', (req: AuthRequest, res: Response) => {
    try {
        const { returnTo = '/settings', context } = req.query as any;
        const state = crypto.randomBytes(32).toString('hex');

        // Validate returnTo to prevent open redirects
        const safeReturnTo = isValidReturnPath(returnTo) ? returnTo : '/settings';

        // Store state and returnTo in httpOnly cookies (expires in 10 min)
        const cookieOptions = {
            httpOnly: true,
            secure: true,
            sameSite: 'lax',
            maxAge: 10 * 60 * 1000
        } as any;

        res.cookie('oauth_state', state, cookieOptions);
        res.cookie('oauth_return_to', safeReturnTo, cookieOptions);

        const authUrl = calendarService.getAuthUrl(state);
        console.log('Generated Google Auth URL with state and returnTo', { state, returnTo: safeReturnTo, context });
        res.json({ authUrl });
    } catch (error: any) {
        console.error('Get auth URL error:', error);
        res.status(500).json({ error: 'Failed to generate auth URL' });
    }
});

/**
 * OAuth callback - exchange code for tokens (authenticated)
 * This is where tokens are actually exchanged and stored
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

        // Store tokens and update calendar status in database
        const { error: updateError } = await supabase
            .from('restaurants')
            .update({
                google_calendar_tokens: JSON.stringify(tokens),
                calendar_status: 'connected',
                calendar_provider: 'google',
                calendar_skipped_at: null,
            })
            .eq('id', restaurantId);

        if (updateError) {
            console.error('Calendar callback update error:', updateError);
            return res.status(500).json({ error: 'Failed to update calendar status' });
        }

        // Return safe response WITHOUT tokens
        res.json({
            success: true,
            calendar_status: 'connected',
            calendar_provider: 'google'
        });
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

        const { error: updateError } = await supabase
            .from('restaurants')
            .update({
                google_calendar_tokens: null,
                calendar_status: 'pending',
                calendar_provider: null,
                calendar_skipped_at: null,
            })
            .eq('id', restaurantId);

        if (updateError) {
            console.error('Calendar disconnect error:', updateError);
            return res.status(500).json({ error: 'Failed to disconnect calendar' });
        }

        res.json({
            success: true,
            calendar_status: 'pending',
            calendar_provider: null,
            calendar_skipped_at: null
        });
    } catch (error: any) {
        console.error('Calendar disconnect error:', error);
        res.status(500).json({ error: 'Failed to disconnect calendar' });
    }
});

/**
 * Skip Google Calendar (user chooses to continue without it)
 * Marks that user has explicitly skipped Calendar setup
 */
router.post('/skip', async (req: AuthRequest, res: Response) => {
    try {
        const restaurantId = req.user!.restaurantId;

        const { error: updateError } = await supabase
            .from('restaurants')
            .update({
                calendar_status: 'pending',
                calendar_provider: null,
                calendar_skipped_at: new Date().toISOString(),
            })
            .eq('id', restaurantId);

        if (updateError) {
            console.error('Calendar skip error:', updateError);
            return res.status(500).json({ error: 'Failed to skip calendar' });
        }

        res.json({
            success: true,
            calendar_status: 'pending',
            calendar_provider: null,
            calendar_skipped_at: new Date().toISOString()
        });
    } catch (error: any) {
        console.error('Calendar skip error:', error);
        res.status(500).json({ error: 'Failed to skip calendar' });
    }
});

export default router;
