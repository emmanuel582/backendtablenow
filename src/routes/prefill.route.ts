import { Router, Request, Response } from 'express';
import { prefillRestaurant, autocompleteRestaurant } from '../controllers/prefillRestaurant';

const router = Router();

// Legacy endpoints (used by old Register flow)
router.post('/api/restaurants/prefill', prefillRestaurant);
router.post('/api/restaurants/autocomplete', autocompleteRestaurant);

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
    console.error('Autocomplete error:', err);
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
    console.error('Places details error:', err);
    res.status(500).json({ error: 'Details fetch failed' });
  }
});

export default router;
