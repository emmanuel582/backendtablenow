export type UserContext = {
  user: {
    id: string;
    email: string;
  };
  restaurant?: {
    id: string;
    status: string;
    is_complete: boolean;
    has_hours: boolean;
    slug: string;
  };
  subscription?: {
    status: string;
  };
  calendar?: {
    status: string;
    skipped: boolean;
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
 * Single source of truth for onboarding routing.
 *
 * Returns the canonical onboarding route the user must complete next, in strict
 * business order, or '/dashboard' once everything is done. Every value returned
 * here is a REAL frontend page that renders an actionable form/screen — there
 * are no placeholder or "ghost" routes.
 *
 *   restaurant profile → hours → calendar → assistant → success → dashboard
 *
 * Completion is DERIVED from the real DB columns (see getUserContextWithNextRoute):
 *   - restaurant : name + owner_name + address + phone present  (is_complete)
 *   - hours      : opening_hours array is non-empty             (has_hours)
 *   - calendar   : calendar_status === 'connected' OR explicitly skipped
 *   - assistant  : assistant_status === 'active' (auto-provisioned by VAPI)
 *   - success    : onboarding_status === 'complete' (persisted at /setup/success)
 */
export function resolveNextRoute(ctx: UserContext): string | null {
  // Not linked to a restaurant yet — profile is the entry step.
  if (!ctx.restaurant) {
    return '/setup/restaurant';
  }

  // 1. Restaurant profile
  if (!ctx.restaurant.is_complete) {
    return '/setup/restaurant';
  }

  // 2. Opening hours
  if (!ctx.restaurant.has_hours) {
    return '/setup/hours';
  }

  // 3. Calendar — connected or explicitly skipped is enough to proceed.
  const calendarDecided = ctx.calendar?.status === 'connected' || ctx.calendar?.skipped === true;
  if (!calendarDecided) {
    return '/setup/calendar';
  }

  // 4. Voice assistant must be provisioned and active.
  if (ctx.assistant?.status !== 'active') {
    return '/setup/assistant';
  }

  // 5. All business steps satisfied. Until the user acknowledges the success
  //    screen (which persists onboarding_status='complete'), send them there.
  if (ctx.onboarding?.status !== 'complete') {
    return '/setup/success';
  }

  return '/dashboard';
}
