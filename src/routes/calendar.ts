import { Router, Response, Request } from 'express';
import crypto from 'crypto';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import supabase from '../config/supabase';
import calendarService from '../services/calendar.service';
import { buildIcsFeed } from '../services/ics.service';
import { config } from '../lib/config';
import logger from '../lib/logger';
import { validate } from '../middleware/handlers';
import { ValidatedCalendarCallback } from '../schemas/calendarCallbackSchema';

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

function feedUrls(restaurantId: string, token: string) {
    const url = `${config.backendUrl}/api/calendar/feed/${restaurantId}/${token}.ics`;
    return {
        feedUrl: url,
        // webcal:// makes one-tap subscribe work on Apple/Outlook/Google.
        webcalUrl: url.replace(/^https?:\/\//, 'webcal://'),
    };
}

// ─── Public: universal ICS feed ───────────────────────────────────────────────
// Any calendar app (Google, Apple, Outlook, …) can subscribe to this URL.
// Auth is via the unguessable per-restaurant feed token, so this must be public.
router.get('/feed/:restaurantId/:token', async (req: Request, res: Response) => {
    try {
        const { restaurantId } = req.params;
        const token = req.params.token.replace(/\.ics$/i, '');

        const { data: restaurant } = await supabase
            .from('restaurants')
            .select('id, name, timezone, default_duration_min, calendar_feed_token')
            .eq('id', restaurantId)
            .single();

        if (!restaurant || !restaurant.calendar_feed_token || restaurant.calendar_feed_token !== token) {
            return res.status(404).send('Not found');
        }

        // Recent past (so cancellations propagate) + everything upcoming.
        const since = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString().split('T')[0];
        const { data: bookings } = await supabase
            .from('bookings')
            .select('id, booking_date, booking_time, booked_for, party_size, covers, guest_name, guest_phone, guest_email, special_requests, confirmation_number, status, updated_at')
            .eq('restaurant_id', restaurantId)
            .gte('booking_date', since)
            .order('booking_date', { ascending: true });

        const ics = buildIcsFeed(restaurant, bookings || []);

        res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
        res.setHeader('Content-Disposition', `inline; filename="tablenow-${restaurantId}.ics"`);
        res.setHeader('Cache-Control', 'no-cache');
        return res.send(ics);
    } catch (error: any) {
        logger.error({ err: error }, 'ICS feed error');
        return res.status(500).send('Internal error');
    }
});

/**
 * Handle Google OAuth callback (Redirect from Google).
 * Public — Google doesn't allow auth headers in redirects. Validates CSRF state,
 * then redirects to the frontend with the code (exchanged via POST /callback).
 */
router.get('/callback', (req: any, res: Response) => {
    const { code, error, state } = req.query;
    const cookieState = req.cookies?.oauth_state;
    const cookieReturnTo = req.cookies?.oauth_return_to;

    const returnTo = isValidReturnPath(cookieReturnTo) ? cookieReturnTo : '/settings';

    const fail = (reason: string) => {
        res.clearCookie('oauth_state');
        res.clearCookie('oauth_return_to');
        return res.redirect(`${config.frontendUrl}${returnTo}?error=${encodeURIComponent(reason)}`);
    };

    if (error) return fail(String(error));
    if (!code) return fail('no_code');
    if (!state) {
        logger.error({ action: 'calendar_callback', has_cookie: !!cookieState }, 'OAuth callback missing state');
        return fail('invalid_state');
    }
    if (!cookieState) {
        logger.error({ action: 'calendar_callback' }, 'OAuth state cookie not found');
        return fail('invalid_state');
    }
    if (state !== cookieState) {
        logger.error({ action: 'calendar_callback' }, 'OAuth state mismatch');
        return fail('invalid_state');
    }

    res.clearCookie('oauth_state');
    res.clearCookie('oauth_return_to');
    res.redirect(`${config.frontendUrl}${returnTo}?code=${code}`);
});

router.use(authenticateToken);

/**
 * Get Google Calendar authorization URL.
 * Supports ?returnTo=<path>&context=setup|dashboard
 */
router.get('/auth-url', (req: AuthRequest, res: Response) => {
    try {
        const { returnTo = '/settings', context } = req.query as any;
        const state = crypto.randomBytes(32).toString('hex');
        const safeReturnTo = isValidReturnPath(returnTo) ? returnTo : '/settings';

        const cookieOptions = {
            httpOnly: true,
            secure: true,
            sameSite: 'lax',
            maxAge: 10 * 60 * 1000,
            path: '/',
        } as any;

        res.cookie('oauth_state', state, cookieOptions);
        res.cookie('oauth_return_to', safeReturnTo, cookieOptions);

        const authUrl = calendarService.getAuthUrl(state);
        logger.info({ returnTo: safeReturnTo, context }, 'Generated calendar auth URL');
        res.json({ authUrl });
    } catch (error: any) {
        logger.error({ err: error }, 'Get auth URL error');
        res.status(500).json({ error: 'Failed to generate auth URL' });
    }
});

/**
 * OAuth callback — exchange code for tokens and store a Google push connection.
 */
router.post('/callback', validate(ValidatedCalendarCallback), async (req: AuthRequest, res: Response) => {
    try {
        const { code } = req.body;
        const restaurantId = req.user!.restaurantId;

        if (!code) return res.status(400).json({ error: 'Authorization code required' });

        const tokens = await calendarService.getTokensFromCode(code);
        const accountEmail = await calendarService.getAccountEmail(tokens);

        // One Google connection per restaurant for now: replace any existing.
        await supabase
            .from('calendar_connections')
            .delete()
            .eq('restaurant_id', restaurantId)
            .eq('provider', 'google');

        const { error: insertError } = await supabase
            .from('calendar_connections')
            .insert({
                restaurant_id: restaurantId,
                provider: 'google',
                account_email: accountEmail,
                calendar_id: 'primary',
                tokens,
                status: 'active',
            });

        if (insertError) {
            logger.error({ action: 'calendar_callback', error: insertError.message, restaurant_id: restaurantId }, 'Connection insert error');
            return res.status(500).json({ error: 'Failed to save calendar connection' });
        }

        await supabase
            .from('restaurants')
            .update({ calendar_status: 'connected', calendar_skipped_at: null })
            .eq('id', restaurantId);

        logger.info({ action: 'calendar_callback', restaurant_id: restaurantId }, 'Calendar connected');
        res.json({ success: true, calendar_status: 'connected', calendar_provider: 'google', account_email: accountEmail });
    } catch (error: any) {
        logger.error({ action: 'calendar_callback', error: error.message }, 'Calendar callback error');
        res.status(500).json({ error: 'Failed to connect calendar' });
    }
});

/**
 * List connected push calendars (never returns tokens).
 */
router.get('/connections', async (req: AuthRequest, res: Response) => {
    try {
        const restaurantId = req.user!.restaurantId;
        const { data, error } = await supabase
            .from('calendar_connections')
            .select('id, provider, account_email, calendar_id, status, sync_enabled, last_synced_at, last_error, created_at')
            .eq('restaurant_id', restaurantId)
            .order('created_at', { ascending: true });

        if (error) return res.status(500).json({ error: 'Failed to load connections' });
        res.json({ connections: data || [] });
    } catch (error: any) {
        logger.error({ err: error }, 'List connections error');
        res.status(500).json({ error: 'Failed to load connections' });
    }
});

/**
 * Get the universal ICS feed URL (subscribe from any calendar app).
 */
router.get('/feed-url', async (req: AuthRequest, res: Response) => {
    try {
        const restaurantId = req.user!.restaurantId;
        const { data: restaurant } = await supabase
            .from('restaurants')
            .select('calendar_feed_token')
            .eq('id', restaurantId)
            .single();

        if (!restaurant?.calendar_feed_token) return res.status(404).json({ error: 'No feed token' });
        res.json({ ...feedUrls(restaurantId, restaurant.calendar_feed_token), token: restaurant.calendar_feed_token });
    } catch (error: any) {
        logger.error({ err: error }, 'Feed URL error');
        res.status(500).json({ error: 'Failed to get feed URL' });
    }
});

/**
 * Rotate the feed token (invalidates the old subscribe URL).
 */
router.post('/feed/rotate', async (req: AuthRequest, res: Response) => {
    try {
        const restaurantId = req.user!.restaurantId;
        const newToken = crypto.randomBytes(24).toString('hex');
        const { error } = await supabase
            .from('restaurants')
            .update({ calendar_feed_token: newToken })
            .eq('id', restaurantId);

        if (error) return res.status(500).json({ error: 'Failed to rotate feed token' });
        res.json({ ...feedUrls(restaurantId, newToken), token: newToken });
    } catch (error: any) {
        logger.error({ err: error }, 'Feed rotate error');
        res.status(500).json({ error: 'Failed to rotate feed token' });
    }
});

/**
 * Disconnect a single push connection by id.
 */
router.delete('/connections/:id', async (req: AuthRequest, res: Response) => {
    try {
        const restaurantId = req.user!.restaurantId;
        const { error } = await supabase
            .from('calendar_connections')
            .delete()
            .eq('id', req.params.id)
            .eq('restaurant_id', restaurantId);

        if (error) return res.status(500).json({ error: 'Failed to disconnect' });

        const { count } = await supabase
            .from('calendar_connections')
            .select('id', { count: 'exact', head: true })
            .eq('restaurant_id', restaurantId);

        if (!count) {
            await supabase.from('restaurants').update({ calendar_status: 'pending' }).eq('id', restaurantId);
        }
        res.json({ success: true });
    } catch (error: any) {
        logger.error({ err: error }, 'Disconnect connection error');
        res.status(500).json({ error: 'Failed to disconnect' });
    }
});

/**
 * Disconnect all Google connections (backward-compatible endpoint).
 */
router.post('/disconnect', async (req: AuthRequest, res: Response) => {
    try {
        const restaurantId = req.user!.restaurantId;
        await supabase
            .from('calendar_connections')
            .delete()
            .eq('restaurant_id', restaurantId)
            .eq('provider', 'google');

        const { count } = await supabase
            .from('calendar_connections')
            .select('id', { count: 'exact', head: true })
            .eq('restaurant_id', restaurantId);

        if (!count) {
            await supabase
                .from('restaurants')
                .update({ calendar_status: 'pending', calendar_skipped_at: null })
                .eq('id', restaurantId);
        }

        res.json({ success: true, calendar_status: count ? 'connected' : 'pending', calendar_provider: null });
    } catch (error: any) {
        logger.error({ err: error }, 'Calendar disconnect error');
        res.status(500).json({ error: 'Failed to disconnect calendar' });
    }
});

/**
 * Skip calendar setup (user continues without connecting).
 */
router.post('/skip', async (req: AuthRequest, res: Response) => {
    try {
        const restaurantId = req.user!.restaurantId;
        const { error: updateError } = await supabase
            .from('restaurants')
            .update({
                calendar_status: 'pending',
                calendar_skipped_at: new Date().toISOString(),
            })
            .eq('id', restaurantId);

        if (updateError) return res.status(500).json({ error: 'Failed to skip calendar' });
        res.json({ success: true, calendar_status: 'pending', calendar_skipped_at: new Date().toISOString() });
    } catch (error: any) {
        logger.error({ err: error }, 'Calendar skip error');
        res.status(500).json({ error: 'Failed to skip calendar' });
    }
});

export default router;
