import supabase from '../config/supabase';
import logger from '../lib/logger';

class PhoneResolutionService {
  async resolveRestaurantId(idOrSlug: string): Promise<string | null> {
    if (!idOrSlug) {
      logger.warn({ action: 'resolve_restaurant_id' }, 'Empty idOrSlug provided');
      return null;
    }

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);

    try {
      if (isUuid) {
        const { data } = await supabase
          .from('restaurants')
          .select('id')
          .eq('id', idOrSlug)
          .single();
        if (data?.id) {
          logger.info({ action: 'resolve_restaurant_id', method: 'uuid' }, 'Restaurant resolved via UUID');
          return data.id;
        }
      } else {
        const { data } = await supabase
          .from('restaurants')
          .select('id')
          .eq('slug', idOrSlug)
          .single();
        if (data?.id) {
          logger.info({ action: 'resolve_restaurant_id', method: 'slug' }, 'Restaurant resolved via slug');
          return data.id;
        }
      }

      logger.warn({ action: 'resolve_restaurant_id', input: idOrSlug }, 'Restaurant not found');
      return null;
    } catch (err: any) {
      logger.error({ action: 'resolve_restaurant_id', error: err.message }, 'Error resolving restaurant');
      return null;
    }
  }

  async resolvePhoneToRestaurant(phoneNumber: string): Promise<any | null> {
    if (!phoneNumber) {
      return null;
    }

    try {
      const { data } = await supabase
        .from('restaurants')
        .select('*')
        .eq('vapi_phone_number', phoneNumber)
        .single();

      if (data) {
        logger.info({ action: 'resolve_phone', phone: phoneNumber }, 'Restaurant found for phone number');
      }
      return data || null;
    } catch (err: any) {
      logger.error({ action: 'resolve_phone', error: err.message }, 'Error resolving phone to restaurant');
      return null;
    }
  }
}

export default new PhoneResolutionService();
