import { Router, Response } from 'express';
import crypto from 'crypto';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import supabase from '../config/supabase';
import calendarService from '../services/calendar.service';
import { config } from '../lib/config';
import { encrypt } from '../lib/crypto';

const router = Router();

/**
 * PUBLIC — Google redirects here after the user grants consent.
 *
 * The full PKCE token exchange happens server-side:
 *   1. Reads {state, codeVerifier, restaurantId} from the httpOnly cookie.
 *   2. Verifies the state against the query-string state (CSRF guard).
 *   3. Exchanges the code for tokens using the stored codeVerifier.
 *   4. Encrypts and persists the tokens in the DB.
 *   5. Redirects the browser to the frontend settings page.
 *
 * The authorization code and token material never touch the browser JS context.
 */
router.get('/callback', async (req: any, res: Response) => {
    const { code, error, state } = req.query;
    const frontendUrl = config.frontendUrl;

    if (error) {
        return res.redirect(`${frontendUrl}/settings?calendar=error&reason=${error}`);
    }
    if (!code) {
        return res.redirect(`${frontendUrl}/settings?calendar=error&reason=no_code`);
    }

    const cookieRaw = req.cookies?.google_oauth;
    if (!cookieRaw) {
        console.error('[calendar/callback] Missing google_oauth cookie');
        return res.redirect(`${frontendUrl}/settings?calendar=error&reason=no_session`);
    }

    let session: { state: string; codeVerifier: string; restaurantId: string };
    try {
        session = JSON.parse(cookieRaw);
    } catch {
        return res.redirect(`${frontendUrl}/settings?calendar=error&reason=invalid_session`);
    }

    if (!state || state !== session.state) {
        console.error('[calendar/callback] OAuth state mismatch — possible CSRF', { received: state, expected: session.state });
        res.clearCookie('google_oauth');
        return res.redirect(`${frontendUrl}/settings?calendar=error&reason=state_mismatch`);
    }

    // Consume the session cookie immediately (one-time use).
    res.clearCookie('google_oauth', { httpOnly: true, secure: true, sameSite: 'none' });

    try {
        const tokens         = await calendarService.getTokensFromCode(code as string, session.codeVerifier);
        const encryptedTokens = encrypt(JSON.stringify(tokens));

        const { error: dbError } = await supabase
            .from('restaurants')
            .update({
                google_calendar_tokens:    encryptedTokens,
                google_calendar_connected: true,
            })
            .eq('id', session.restaurantId);

        if (dbError) {
            console.error('[calendar/callback] DB update error:', dbError);
            return res.redirect(`${frontendUrl}/settings?calendar=error&reason=db_error`);
        }

        console.log(`[calendar/callback] ✅ Calendar connected for restaurant ${session.restaurantId}`);
        return res.redirect(`${frontendUrl}/settings?calendar=connected`);
    } catch (err: any) {
        console.error('[calendar/callback] Token exchange error:', err?.message || err);
        return res.redirect(`${frontendUrl}/settings?calendar=error&reason=token_exchange`);
    }
});

// All routes below require a valid JWT.
router.use(authenticateToken);

/**
 * AUTHENTICATED — Generate the Google OAuth authorization URL.
 *
 * Generates a fresh PKCE pair and a random state token, stores all three
 * ({state, codeVerifier, restaurantId}) in a short-lived httpOnly cookie,
 * then returns the authorization URL for the frontend to redirect to.
 *
 * The frontend never sees the codeVerifier — only the authUrl.
 */
router.get('/auth-url', (req: AuthRequest, res: Response) => {
    try {
        const { codeVerifier, codeChallenge } = calendarService.generatePKCE();
        const state = crypto.randomBytes(32).toString('hex');

        const sessionPayload = JSON.stringify({
            state,
            codeVerifier,
            restaurantId: req.user!.restaurantId,
        });

        // httpOnly + SameSite=None so the cookie survives the cross-origin redirect
        // (frontend → Google → backend callback).
        res.cookie('google_oauth', sessionPayload, {
            httpOnly: true,
            secure:   true,
            sameSite: 'none',
            maxAge:   10 * 60 * 1000, // 10 minutes
        });

        const authUrl = calendarService.getAuthUrl(state, codeChallenge);
        console.log(`[calendar/auth-url] Generated OAuth URL for restaurant ${req.user!.restaurantId}`);
        res.json({ authUrl });
    } catch (error: any) {
        console.error('[calendar/auth-url] Error:', error);
        res.status(500).json({ error: 'Failed to generate auth URL' });
    }
});

/**
 * AUTHENTICATED — Disconnect Google Calendar.
 */
router.post('/disconnect', async (req: AuthRequest, res: Response) => {
    try {
        const restaurantId = req.user!.restaurantId;

        await supabase
            .from('restaurants')
            .update({
                google_calendar_tokens:    null,
                google_calendar_connected: false,
            })
            .eq('id', restaurantId);

        res.json({ message: 'Calendar disconnected successfully' });
    } catch (error: any) {
        console.error('[calendar/disconnect] Error:', error);
        res.status(500).json({ error: 'Failed to disconnect calendar' });
    }
});

export default router;
