// Single source of routing truth. resolveNextRoute is the ONLY place that decides where
// the frontend goes after auth or after a config write. The frontend must follow this
// value verbatim and never reconstruct routes from local heuristics (user id, slug,
// Supabase session, is_complete, silent fallbacks).
//
// This function only ever runs in an AUTHENTICATED context: it is called from
// GET /auth/app-state, which sits behind authenticateToken and a resolved restaurant.
// Therefore it must NEVER send an authenticated user to '/login'. A missing restaurant
// or slug is a controlled inconsistency, signalled with `null` so the frontend can show
// a contained error state (NotLinked) instead of bouncing to the login screen.
//
// Decision order (only restaurant identity gates routing in this lot — calendar,
// provisioning and assistant are surfaced as state but never block the dashboard):
//   no restaurant / no slug → null        (controlled error, never /login)
//   restaurant incomplete   → /r/:slug/onboarding
//   restaurant complete     → /r/:slug/dashboard

export interface RoutingState {
  restaurant: { slug?: string | null; is_complete?: boolean } | null;
}

export function resolveNextRoute(state: RoutingState): string | null {
  const restaurant = state.restaurant;
  const slug = restaurant?.slug;

  // Authenticated but no usable restaurant/slug → contained error, NOT a logout.
  if (!restaurant || !slug) return null;

  // Identity profile incomplete → guided onboarding for this restaurant.
  if (!restaurant.is_complete) return `/r/${slug}/onboarding`;

  // Operational → slug-scoped dashboard.
  return `/r/${slug}/dashboard`;
}
