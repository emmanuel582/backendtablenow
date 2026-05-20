import { Router, Request, Response } from 'express';
import { AuthRequest, authenticateToken } from '../middleware/auth';
import supabase from '../config/supabase';
import { resolveNextRoute, type UserContext } from '../lib/routing';

const router = Router();

export async function getUserContextWithNextRoute(req: AuthRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const restaurantId = req.user?.restaurantId;

    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // Fetch restaurant data
    let restaurant = null;
    if (restaurantId) {
      const { data, error } = await supabase
        .from('restaurants')
        .select('*')
        .eq('id', restaurantId)
        .single();

      if (error && error.code !== 'PGRST116') {
        console.error('Error fetching restaurant:', error);
      }
      restaurant = data;
    }

    // Determine if restaurant is complete
    const is_complete =
      restaurant &&
      restaurant.name &&
      restaurant.owner_name &&
      restaurant.address &&
      restaurant.phone;

    // Build user context
    const ctx: UserContext = {
      user: {
        id: userId,
        email: req.user?.email || '',
      },
      restaurant: restaurant
        ? {
            id: restaurant.id,
            status: restaurant.restaurant_status || 'draft',
            is_complete: !!is_complete,
            slug: restaurant.slug,
          }
        : undefined,
      subscription: restaurant
        ? {
            status: restaurant.subscription_status || 'none',
          }
        : undefined,
      calendar: restaurant
        ? {
            status: restaurant.calendar_status || 'not_connected',
          }
        : undefined,
      provisioning: restaurant
        ? {
            status: restaurant.provisioning_status || 'not_started',
          }
        : undefined,
      assistant: restaurant
        ? {
            status: restaurant.assistant_status || 'inactive',
          }
        : undefined,
      onboarding: restaurant
        ? {
            status: restaurant.onboarding_status || 'not_started',
          }
        : undefined,
      test_call_completed: restaurant?.test_call_completed || false,
    };

    // Resolve next route
    const next_route = resolveNextRoute(ctx);

    // Return full context
    return res.json({
      user: ctx.user,
      restaurant: restaurant
        ? {
            id: restaurant.id,
            name: restaurant.name,
            slug: restaurant.slug,
            status: restaurant.restaurant_status,
            is_complete,
            phone: restaurant.phone,
            email: restaurant.email,
          }
        : null,
      subscription: {
        status: ctx.subscription?.status || 'none',
      },
      calendar: {
        status: ctx.calendar?.status || 'not_connected',
      },
      provisioning: {
        status: ctx.provisioning?.status || 'not_started',
        phone_number: restaurant?.vapi_phone_number,
        assistant_id: restaurant?.vapi_assistant_id,
      },
      onboarding: {
        status: ctx.onboarding?.status || 'not_started',
        test_call_completed: ctx.test_call_completed,
      },
      assistant: {
        status: ctx.assistant?.status || 'inactive',
      },
      next_route,
    });
  } catch (err: any) {
    console.error('[/me] Error:', err);
    return res.status(500).json({
      error: 'Failed to fetch user data',
      detail: err?.message,
    });
  }
}

/**
 * GET /api/me
 * Central endpoint that returns user context + next_route
 * This is the single source of truth for routing decisions
 */
router.get('/me', authenticateToken, getUserContextWithNextRoute);

export default router;
