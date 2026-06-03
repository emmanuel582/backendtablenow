// Single source of routing truth. resolveNextRoute is the ONLY place that decides where
// the frontend goes after auth or after a config write. The frontend must follow this
// value verbatim and never reconstruct routes from local heuristics (user id, slug,
// Supabase session, silent fallbacks).
//
// Target decision order (frontend routing spec §2):
//   no session             → /login
//   no restaurant          → /setup/restaurant
//   hours incomplete       → /setup/hours
//   calendar unconfigured  → /setup/calendar
//   assistant unconfigured → /setup/assistant
//   complete, unconfirmed  → /setup/success
//   complete               → /r/:slug/dashboard
//
// NOTE: the /setup/* gating activates in a later lot, once those pages + their write
// endpoints exist. Routing there now would strand freshly-created OAuth restaurants on
// non-existent pages. For the proven golden path a linked restaurant goes straight to its
// slug-scoped dashboard.

export interface RoutingState {
  restaurant: { slug?: string | null } | null;
}

export function resolveNextRoute(state: RoutingState): string {
  const slug = state.restaurant?.slug;
  if (!slug) return '/login';
  return `/r/${slug}/dashboard`;
}
