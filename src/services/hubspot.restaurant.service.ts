/**
 * HubSpot Restaurant Sync
 * Supabase → HubSpot : 1 restaurant = 1 Company
 * Convives NEVER sent to HubSpot.
 */
import supabase from '../config/supabase';
import logger from '../lib/logger';

const HUBSPOT_TOKEN = process.env.HUBSPOT_API_KEY;
const HUBSPOT_API = 'https://api.hubapi.com';

async function hubspotRequest(method: string, path: string, body?: any) {
    const res = await fetch(`${HUBSPOT_API}${path}`, {
        method,
        headers: {
            'Authorization': `Bearer ${HUBSPOT_TOKEN}`,
            'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`HubSpot ${method} ${path} → ${res.status}: ${err}`);
    }
    return res.json();
}

/**
 * Find existing HubSpot company by domain or name
 */
async function findCompany(name: string): Promise<string | null> {
    try {
        const data: any = await hubspotRequest('POST', '/crm/v3/objects/companies/search', {
            filterGroups: [{
                filters: [{
                    propertyName: 'name',
                    operator: 'EQ',
                    value: name
                }]
            }],
            properties: ['name'],
            limit: 1
        });
        return data.results?.[0]?.id || null;
    } catch {
        return null;
    }
}

/**
 * Create or update a HubSpot Company for a restaurant.
 * Stores the company ID back in restaurants.hubspot_company_id.
 */
export async function syncRestaurantToHubSpot(restaurantId: string): Promise<string | null> {
    if (!HUBSPOT_TOKEN) {
        logger.warn({ action: 'hubspot_sync' }, 'HUBSPOT_API_KEY not set — skipping');
        return null;
    }

    const { data: restaurant, error } = await supabase
        .from('restaurants')
        .select('id, name, phone, hubspot_company_id')
        .eq('id', restaurantId)
        .single();

    if (error || !restaurant) {
        logger.error({ action: 'hubspot_sync', restaurant_id: restaurantId }, 'Restaurant not found');
        return null;
    }

    const properties = {
        name: restaurant.name,
        phone: restaurant.phone || '',
        industry: 'RESTAURANT',
        description: 'Géré via TableNow'
    };

    try {
        let companyId = restaurant.hubspot_company_id;

        if (companyId) {
            // Update existing company
            await hubspotRequest('PATCH', `/crm/v3/objects/companies/${companyId}`, { properties });
            logger.info({ action: 'hubspot_sync', company_id: companyId, restaurant_name: restaurant.name }, 'Updated company');
        } else {
            // Try to find by name first (avoid duplicates)
            companyId = await findCompany(restaurant.name);

            if (companyId) {
                await hubspotRequest('PATCH', `/crm/v3/objects/companies/${companyId}`, { properties });
                logger.info({ action: 'hubspot_sync', company_id: companyId, restaurant_name: restaurant.name }, 'Found & updated company');
            } else {
                const created: any = await hubspotRequest('POST', '/crm/v3/objects/companies', { properties });
                companyId = created.id;
                logger.info({ action: 'hubspot_sync', company_id: companyId, restaurant_name: restaurant.name }, 'Created company');
            }

            // Store back in Supabase
            await supabase
                .from('restaurants')
                .update({ hubspot_company_id: companyId })
                .eq('id', restaurantId);
        }

        return companyId;
    } catch (err: any) {
        logger.error({ action: 'hubspot_sync', error: err.message }, 'HubSpot sync error');
        return null;
    }
}
