// ============================================
// Phone Resolution Service — Voice Core
// Resolves caller numbers, restaurant IDs, or slugs to a restaurant entity
// Provider-agnostic: any voice provider can use this
// ============================================

import supabase from '../../config/supabase';
import logger from '../../lib/logger';
import type { ResolvedVoiceRestaurant } from '../../types/voice.types';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RestaurantRow = {
  id: string;
  name: string | null;
  slug: string | null;
  address: string | null;
  phone: string | null;
  opening_hours: unknown;
  language: string | null;
};

function toResolvedRestaurant(row: RestaurantRow): ResolvedVoiceRestaurant {
  return {
    id: row.id,
    name: row.name ?? '',
    slug: row.slug ?? '',
    address: row.address ?? '',
    phone: row.phone ?? '',
    opening_hours: row.opening_hours,
    language: row.language === 'en' ? 'en' : 'fr',
  };
}

class PhoneResolutionService {
  async resolveById(id: string): Promise<ResolvedVoiceRestaurant | null> {
    if (!id) return null;

    const { data, error } = await supabase
      .from('restaurants')
      .select('id, name, slug, address, phone, opening_hours, language')
      .eq('id', id)
      .single();

    if (error || !data) {
      logger.warn(
        { action: 'resolve_by_id', restaurant_id: id },
        'Restaurant not found by ID'
      );
      return null;
    }

    return toResolvedRestaurant(data as RestaurantRow);
  }

  async resolveBySlug(slug: string): Promise<ResolvedVoiceRestaurant | null> {
    if (!slug) return null;

    const { data, error } = await supabase
      .from('restaurants')
      .select('id, name, slug, address, phone, opening_hours, language')
      .eq('slug', slug)
      .single();

    if (error || !data) {
      logger.warn(
        { action: 'resolve_by_slug', slug },
        'Restaurant not found by slug'
      );
      return null;
    }

    return toResolvedRestaurant(data as RestaurantRow);
  }

  async resolveByPhone(
    phoneNumber: string
  ): Promise<ResolvedVoiceRestaurant | null> {
    if (!phoneNumber) return null;

    const { data, error } = await supabase
      .from('restaurants')
      .select('id, name, slug, address, phone, opening_hours, language')
      .eq('vapi_phone_number', phoneNumber)
      .single();

    if (error || !data) {
      logger.warn(
        { action: 'resolve_by_phone', phone: phoneNumber },
        'Restaurant not found by phone number'
      );
      return null;
    }

    return toResolvedRestaurant(data as RestaurantRow);
  }

  async resolveByIdOrSlug(
    idOrSlug: string
  ): Promise<ResolvedVoiceRestaurant | null> {
    if (!idOrSlug) return null;

    return UUID_REGEX.test(idOrSlug)
      ? this.resolveById(idOrSlug)
      : this.resolveBySlug(idOrSlug);
  }
}

export default new PhoneResolutionService();
