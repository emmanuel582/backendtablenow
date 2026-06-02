export type UserContext = {
  user: {
    id: string;
    email: string;
  };
  restaurant?: {
    id: string;
    status: string;
    is_complete: boolean;
    slug: string;
  };
  subscription?: {
    status: string;
  };
  calendar?: {
    status: string;
  };
  provisioning?: {
    status: string;
  };
  assistant?: {
    status: string;
  };
  onboarding?: {
    status: string;
  };
  test_call_completed: boolean;
};

/**
 * Resolves the single canonical landing route for a user, given their context.
 *
 * Contract: this function returns ONLY real, terminal frontend routes —
 * `/settings`, `/billing`, or `/dashboard`. It never emits `/setup/*` paths
 * (those do not exist as pages and were the historical source of redirect
 * loops). The ordering mirrors the dashboard guard stack on the frontend
 * (Onboarding → Subscription → RestaurantComplete) so that `next_route` always
 * points at the first surface where a guard would otherwise send the user.
 *
 *   • Onboarding incomplete / no restaurant  → `/settings`  (setup happens here)
 *   • Subscription not active/trial          → `/billing`
 *   • Restaurant profile incomplete          → `/settings`
 *   • Everything satisfied                    → `/dashboard`
 *
 * Assistant/calendar provisioning is intentionally NOT gated here: the
 * dashboard does not require an active assistant (only the /calls page does,
 * via AssistantGuard), so it must not influence the primary landing route.
 */
export function resolveNextRoute(ctx: UserContext): string | null {
  if (!ctx.restaurant) {
    return '/settings';
  }

  if (ctx.onboarding?.status && ctx.onboarding.status !== 'complete') {
    return '/settings';
  }

  const subscription = ctx.subscription?.status;
  const subscriptionActive = subscription === 'active' || subscription === 'trial';
  if (!subscriptionActive) {
    return '/billing';
  }

  if (!ctx.restaurant.is_complete) {
    return '/settings';
  }

  return '/dashboard';
}
