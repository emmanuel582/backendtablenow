import { resolveNextRoute, type UserContext } from '../../lib/routing';

// Helper: a fully-onboarded context; override fields to simulate each gap.
function ctx(overrides: Partial<UserContext> = {}): UserContext {
  return {
    user: { id: 'u1', email: 'a@b.c' },
    restaurant: { id: 'r1', status: 'active', is_complete: true, has_hours: true, slug: 'r1' },
    subscription: { status: 'active' },
    calendar: { status: 'connected', skipped: false },
    provisioning: { status: 'complete' },
    assistant: { status: 'active' },
    onboarding: { status: 'complete' },
    test_call_completed: true,
    ...overrides,
  };
}

describe('resolveNextRoute — onboarding contract', () => {
  it('routes to /setup/restaurant when there is no restaurant', () => {
    expect(resolveNextRoute(ctx({ restaurant: undefined }))).toBe('/setup/restaurant');
  });

  it('routes to /setup/restaurant when profile is incomplete', () => {
    expect(
      resolveNextRoute(ctx({ restaurant: { id: 'r1', status: 'draft', is_complete: false, has_hours: false, slug: 'r1' } }))
    ).toBe('/setup/restaurant');
  });

  it('routes to /setup/hours when profile is complete but hours are missing', () => {
    expect(
      resolveNextRoute(ctx({ restaurant: { id: 'r1', status: 'draft', is_complete: true, has_hours: false, slug: 'r1' } }))
    ).toBe('/setup/hours');
  });

  it('routes to /setup/calendar when calendar is neither connected nor skipped', () => {
    expect(resolveNextRoute(ctx({ calendar: { status: 'not_connected', skipped: false } }))).toBe('/setup/calendar');
  });

  it('accepts a skipped calendar and moves on', () => {
    expect(resolveNextRoute(ctx({ calendar: { status: 'pending', skipped: true } }))).toBe('/dashboard');
  });

  it('routes to /setup/assistant when the assistant is not active', () => {
    expect(resolveNextRoute(ctx({ assistant: { status: 'provisioning' } }))).toBe('/setup/assistant');
  });

  it('routes to /setup/success when all steps pass but onboarding is not acknowledged', () => {
    expect(resolveNextRoute(ctx({ onboarding: { status: 'in_progress' } }))).toBe('/setup/success');
  });

  it('routes to /dashboard when everything is complete', () => {
    expect(resolveNextRoute(ctx())).toBe('/dashboard');
  });

  it('never emits a ghost /setup/vapi route', () => {
    const samples = [
      ctx({ restaurant: undefined }),
      ctx({ provisioning: { status: 'provisioning' }, assistant: { status: 'provisioning' } }),
      ctx({ assistant: { status: 'inactive' } }),
    ];
    for (const c of samples) {
      expect(resolveNextRoute(c)).not.toBe('/setup/vapi');
    }
  });

  it('respects strict ordering: profile before hours before calendar before assistant', () => {
    // Everything broken at once → must surface the FIRST gap (restaurant).
    const allBroken = ctx({
      restaurant: { id: 'r1', status: 'draft', is_complete: false, has_hours: false, slug: 'r1' },
      calendar: { status: 'not_connected', skipped: false },
      assistant: { status: 'inactive' },
      onboarding: { status: 'not_started' },
    });
    expect(resolveNextRoute(allBroken)).toBe('/setup/restaurant');
  });
});
