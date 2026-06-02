// src/controllers/prefillRestaurant.ts
// Prefill restaurant data from Google Places API and/or website scraping
// Called once at onboarding — not in real-time flow

import { Request, Response } from 'express';
import logger from '../lib/logger';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import type { Element } from 'domhandler';

interface PrefillResult {
    name?: string;
    address?: string;
    phone?: string;
    website?: string;
    description?: string;
    hours?: WeeklyHours;
    cuisine_type?: string;
    services?: string[];
    sources: ('google_places' | 'website')[];
}

interface WeeklyHours {
    monday?: string; tuesday?: string; wednesday?: string;
    thursday?: string; friday?: string; saturday?: string; sunday?: string;
}

async function resolveShortUrl(url: string): Promise<string> {
    try {
        const res = await axios.get(url, { maxRedirects: 5, timeout: 5000 });
        return res.request.res.responseUrl || url;
    } catch { return url; }
}

function extractPlaceIdFromUrl(url: string): string | null {
    const chijMatch = url.match(/place_id=([^&]+)/);
    if (chijMatch) return chijMatch[1];
    const chijDirect = url.match(/(ChIJ[A-Za-z0-9_\-]+)/);
    if (chijDirect) return chijDirect[1];
    return null;
}

function extractQueryFromUrl(url: string): string {
    const nameMatch = url.match(/\/place\/([^/@?]+)/);
    if (nameMatch) return decodeURIComponent(nameMatch[1].replace(/\+/g, ' '));
    return url;
}

function formatHoursNew(regularOpeningHours: any): WeeklyHours {
    const dayNames: (keyof WeeklyHours)[] = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const result: WeeklyHours = {};
    for (const period of regularOpeningHours?.periods || []) {
        const dayKey = dayNames[period.open?.day];
        if (!dayKey) continue;
        const openH = String(period.open?.hour ?? 0).padStart(2, '0');
        const openM = String(period.open?.minute ?? 0).padStart(2, '0');
        const closeH = String(period.close?.hour ?? 0).padStart(2, '0');
        const closeM = String(period.close?.minute ?? 0).padStart(2, '0');
        result[dayKey] = `${openH}:${openM} - ${closeH}:${closeM}`;
    }
    return result;
}

async function fetchGooglePlaces(googleMapsUrl: string): Promise<Partial<PrefillResult>> {
    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) throw new Error('GOOGLE_PLACES_API_KEY not set');

    const resolvedUrl = /goo\.gl|maps\.app/.test(googleMapsUrl)
        ? await resolveShortUrl(googleMapsUrl) : googleMapsUrl;

    const fieldMask = [
        'places.displayName','places.formattedAddress','places.nationalPhoneNumber',
        'places.websiteUri','places.regularOpeningHours','places.primaryTypeDisplayName',
        'places.types','places.editorialSummary','places.id',
    ].join(',');

    const headers = {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': fieldMask,
        'Accept-Language': 'fr',
    };

    let place: any = null;
    const placeId = extractPlaceIdFromUrl(resolvedUrl);

    if (placeId && placeId.startsWith('ChIJ')) {
        const detailRes = await axios.get(`https://places.googleapis.com/v1/places/${placeId}`, { headers });
        place = detailRes.data;
    }

    if (!place) {
        const query = extractQueryFromUrl(resolvedUrl);
        const searchRes = await axios.post(
            'https://places.googleapis.com/v1/places:searchText',
            { textQuery: query, languageCode: 'fr', maxResultCount: 1,
                locationBias: { rectangle: { low: { latitude: 41.3, longitude: -5.1 }, high: { latitude: 51.1, longitude: 9.6 } } } },
            { headers }
        );
        place = searchRes.data?.places?.[0] || null;
    }

    if (!place) throw new Error('Could not resolve place from Google Maps URL');

    const cuisineTypes = (place.types || [])
        .filter((t: string) => !['establishment','point_of_interest','food','restaurant'].includes(t))
        .map((t: string) => t.replace(/_/g, ' ')).slice(0, 3);

    return {
        name: place.displayName?.text, address: place.formattedAddress,
        phone: place.nationalPhoneNumber, website: place.websiteUri,
        description: place.editorialSummary?.text,
        hours: place.regularOpeningHours ? formatHoursNew(place.regularOpeningHours) : undefined,
        cuisine_type: place.primaryTypeDisplayName?.text || cuisineTypes[0],
        services: cuisineTypes.length ? cuisineTypes : undefined,
    };
}

async function fetchByPlaceId(placeId: string): Promise<Partial<PrefillResult>> {
    const apiKey = process.env.GOOGLE_PLACES_API_KEY!;

    const fieldMask = [
        'displayName', 'formattedAddress', 'nationalPhoneNumber',
        'websiteUri', 'regularOpeningHours', 'primaryTypeDisplayName',
        'types', 'editorialSummary',
    ].join(',');

    const res = await axios.get(
        `https://places.googleapis.com/v1/places/${placeId}`,
        {
            headers: {
                'X-Goog-Api-Key': apiKey,
                'X-Goog-FieldMask': fieldMask,
                'Accept-Language': 'fr',
            },
        }
    );

    const place = res.data;
    if (!place) throw new Error('Place not found');

    const cuisineTypes = (place.types || [])
        .filter((t: string) => !['establishment', 'point_of_interest', 'food', 'restaurant'].includes(t))
        .map((t: string) => t.replace(/_/g, ' '))
        .slice(0, 3);

    return {
        name:         place.displayName?.text,
        address:      place.formattedAddress,
        phone:        place.nationalPhoneNumber,
        website:      place.websiteUri,
        description:  place.editorialSummary?.text,
        hours:        place.regularOpeningHours ? formatHoursNew(place.regularOpeningHours) : undefined,
        cuisine_type: place.primaryTypeDisplayName?.text || cuisineTypes[0],
        services:     cuisineTypes.length ? cuisineTypes : undefined,
    };
}

function extractPhone(text: string): string | null {
    const match = text.match(/(?:\+33|0033|0)[1-9](?:[\s.\-]?\d{2}){4}/);
    return match ? match[0].trim() : null;
}

function extractEmail(text: string): string | null {
    const match = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    return match ? match[0] : null;
}

async function scrapeWebsite(url: string): Promise<Partial<PrefillResult>> {
    const res = await axios.get(url, {
        timeout: 8000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TableNow/1.0; +https://tablenow.io)', 'Accept-Language': 'fr-FR,fr;q=0.9' },
        maxRedirects: 3,
    });

    const html = res.data as string;
    const $ = cheerio.load(html);

    const metaDescription =
        $('meta[name="description"]').attr('content') ||
        $('meta[property="og:description"]').attr('content') ||
        $('meta[name="twitter:description"]').attr('content');

    const metaName =
        $('meta[property="og:site_name"]').attr('content') ||
        $('meta[property="og:title"]').attr('content');

    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    const mainText = article?.textContent || '';

    const fullText = $.text();
    const phone = extractPhone(fullText);
    const email = extractEmail(fullText);

    let ldName: string | undefined, ldAddress: string | undefined;
    let ldPhone: string | undefined, ldHours: WeeklyHours | undefined, ldCuisine: string | undefined;

    $('script[type="application/ld+json"]').each((_: number, el: Element) => {
        try {
            const data = JSON.parse($(el).html() || '{}');
            const entry = Array.isArray(data) ? data[0] : data;
            if (entry['@type'] === 'Restaurant' || entry['@type'] === 'FoodEstablishment') {
                ldName = entry.name; ldPhone = entry.telephone; ldCuisine = entry.servesCuisine;
                if (entry.address) {
                    ldAddress = typeof entry.address === 'string' ? entry.address
                        : [entry.address.streetAddress, entry.address.addressLocality, entry.address.postalCode].filter(Boolean).join(', ');
                }
                if (entry.openingHoursSpecification) {
                    ldHours = {};
                    const dayMap: Record<string, keyof WeeklyHours> = {
                        Monday:'monday', Tuesday:'tuesday', Wednesday:'wednesday',
                        Thursday:'thursday', Friday:'friday', Saturday:'saturday', Sunday:'sunday',
                    };
                    for (const spec of entry.openingHoursSpecification) {
                        const days = Array.isArray(spec.dayOfWeek) ? spec.dayOfWeek : [spec.dayOfWeek];
                        for (const day of days) {
                            const key = dayMap[day.replace('https://schema.org/', '')];
                            if (key) ldHours[key] = `${spec.opens} - ${spec.closes}`;
                        }
                    }
                }
            }
        } catch {}
    });

    return {
        name: ldName || metaName, address: ldAddress,
        phone: ldPhone || phone || undefined,
        description: metaDescription || mainText.slice(0, 500) || undefined,
        hours: ldHours, cuisine_type: ldCuisine,
        ...(email && { pms_email_hint: email }),
    } as Partial<PrefillResult>;
}

function merge(places: Partial<PrefillResult> | null, website: Partial<PrefillResult> | null): PrefillResult {
    const result: PrefillResult = { sources: [] };
    if (places) result.sources.push('google_places');
    if (website) result.sources.push('website');
    result.name = places?.name || website?.name;
    result.address = places?.address || website?.address;
    result.phone = places?.phone || website?.phone;
    result.website = places?.website || undefined;
    result.hours = places?.hours || website?.hours;
    result.cuisine_type = places?.cuisine_type || website?.cuisine_type;
    result.description = website?.description || places?.description;
    result.services = places?.services;
    return result;
}

export async function autocompleteRestaurant(req: Request, res: Response) {
    const { query } = req.body;
    if (!query || query.length < 2) return res.json({ suggestions: [] });

    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'GOOGLE_PLACES_API_KEY not set' });

    try {
        const response = await axios.post(
            'https://places.googleapis.com/v1/places:autocomplete',
            {
                input: query,
                languageCode: 'fr',
                includedPrimaryTypes: ['restaurant', 'food', 'cafe', 'bar'],
                locationBias: {
                    rectangle: {
                        low:  { latitude: 41.3, longitude: -5.1 },
                        high: { latitude: 51.1, longitude:  9.6 },
                    },
                },
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Goog-Api-Key': apiKey,
                },
            }
        );

        const suggestions = (response.data?.suggestions || [])
            .filter((s: any) => s.placePrediction)
            .map((s: any) => ({
                placeId: s.placePrediction.placeId,
                name:    s.placePrediction.structuredFormat?.mainText?.text || s.placePrediction.text?.text,
                address: s.placePrediction.structuredFormat?.secondaryText?.text || '',
            }));

        return res.json({ suggestions });
    } catch (err: any) {
        logger.error({ err }, '[Autocomplete Error]');
        return res.json({ suggestions: [] });
    }
}

export async function prefillRestaurant(req: Request, res: Response) {
    const { google_maps_url, website_url, place_id } = req.body;

    // If place_id provided directly (from autocomplete selection), fetch details immediately
    if (place_id && !google_maps_url) {
        try {
            const data = await fetchByPlaceId(place_id);
            return res.json({ ...data, sources: ['google_places'] });
        } catch (err: any) {
            return res.status(422).json({ error: err.message });
        }
    }

    if (!google_maps_url && !website_url)
        return res.status(400).json({ error: 'Provide at least google_maps_url or website_url' });

    let placesData: Partial<PrefillResult> | null = null;
    let websiteData: Partial<PrefillResult> | null = null;
    const errors: Record<string, string> = {};

    const [placesResult, websiteResult] = await Promise.allSettled([
        google_maps_url ? fetchGooglePlaces(google_maps_url) : Promise.resolve(null),
        website_url ? scrapeWebsite(website_url) : Promise.resolve(null),
    ]);

    if (placesResult.status === 'fulfilled') placesData = placesResult.value;
    else errors.google_places = placesResult.reason?.message || 'Failed';

    if (websiteResult.status === 'fulfilled') websiteData = websiteResult.value;
    else errors.website = websiteResult.reason?.message || 'Failed';

    if (!placesData && !websiteData)
        return res.status(422).json({ error: 'Both sources failed', details: errors });

    const result = merge(placesData, websiteData);
    if (Object.keys(errors).length) (result as any).errors = errors;
    return res.json(result);
}
