import { Router, Request, Response } from 'express';
import logger from '../lib/logger';
import { prefillRestaurant, autocompleteRestaurant } from '../controllers/prefillRestaurant';

const router = Router();

// ────────────────────────────────────────────────────────────────────────────────
// DEPRECATED LEGACY ENDPOINTS
// Kept for backward compatibility, delegates to new /api/prefill/* routes
// Clients should migrate to GET /api/prefill/autocomplete and GET /api/prefill/details
// ────────────────────────────────────────────────────────────────────────────────

router.post('/api/restaurants/prefill', (req: Request, res: Response, next) => {
    logger.warn('[DEPRECATED] POST /api/restaurants/prefill - use POST /api/restaurants/prefill for now (will be removed in v2)');
    return prefillRestaurant(req, res);
});

router.post('/api/restaurants/autocomplete', (req: Request, res: Response, next) => {
    logger.warn('[DEPRECATED] POST /api/restaurants/autocomplete - use GET /api/prefill/autocomplete instead');
    return autocompleteRestaurant(req, res);
});

/**
 * GET /api/prefill/autocomplete?input=TEXT&sessiontoken=UUID
 * Uses Google Places Autocomplete (New) API
 */
router.get('/api/prefill/autocomplete', async (req: Request, res: Response) => {
  const { input, sessiontoken } = req.query as { input?: string; sessiontoken?: string };
  if (!input) { res.status(400).json({ error: 'input required' }); return; }

  try {
    const response = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY!,
      },
      body: JSON.stringify({ input, sessionToken: sessiontoken }),
    });

    const data = await response.json() as any;

    const suggestions = (data.suggestions || []).map((s: any) => {
      const place = s.placePrediction;
      return {
        placeId:       place?.placeId ?? '',
        description:   place?.text?.text ?? '',
        mainText:      place?.structuredFormat?.mainText?.text ?? '',
        secondaryText: place?.structuredFormat?.secondaryText?.text ?? '',
      };
    });

    res.json({ suggestions });
  } catch (err) {
    logger.error({ err }, 'Autocomplete error');
    res.status(500).json({ error: 'Autocomplete failed' });
  }
});

/**
 * GET /api/prefill/details?placeId=PLACE_ID&sessiontoken=UUID
 * Uses Google Places Details (New) API
 */
router.get('/api/prefill/details', async (req: Request, res: Response) => {
  const { placeId, sessiontoken } = req.query as { placeId?: string; sessiontoken?: string };
  if (!placeId) { res.status(400).json({ error: 'placeId required' }); return; }

  try {
    const headers: Record<string, string> = {
      'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY!,
      'X-Goog-FieldMask': 'displayName,formattedAddress,nationalPhoneNumber,websiteUri,location,regularOpeningHours,primaryTypeDisplayName,googleMapsUri',
    };
    if (sessiontoken) headers['X-Goog-Session-Token'] = sessiontoken;

    const response = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, { headers });
    const data = await response.json() as any;

    res.json({
      name:         data.displayName?.text ?? '',
      address:      data.formattedAddress ?? '',
      phone:        data.nationalPhoneNumber ?? '',
      website:      data.websiteUri ?? '',
      lat:          data.location?.latitude,
      lng:          data.location?.longitude,
      openingHours: data.regularOpeningHours ?? null,
      mapsUrl:      data.googleMapsUri ?? '',
      cuisineType:  data.primaryTypeDisplayName?.text ?? '',
    });
  } catch (err) {
    logger.error({ err }, 'Places details error');
    res.status(500).json({ error: 'Details fetch failed' });
  }
});

export default router;
