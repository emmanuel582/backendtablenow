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

export function resolveNextRoute(ctx: UserContext): string | null {
  if (!ctx.restaurant) {
    return '/setup';
  }

  if (ctx.provisioning?.status === 'not_started' || ctx.provisioning?.status === 'provisioning') {
    return '/setup/vapi';
  }

  if (ctx.assistant?.status === 'inactive') {
    return '/setup/assistant';
  }

  if (ctx.calendar?.status === 'not_connected') {
    return '/setup/calendar';
  }

  if (!ctx.restaurant.is_complete) {
    return '/setup/restaurant';
  }

  return '/dashboard';
}
