import { resolveNextRoute } from '../../lib/routing';

// resolveNextRoute is the single source of post-auth routing truth. It only ever runs
// in an authenticated context, so it must NEVER emit '/login'. The whole flow (scenarios
// in the lot spec) is pinned here.
describe('resolveNextRoute (single source of routing truth)', () => {
  it('routes an incomplete restaurant to its slug-scoped onboarding', () => {
    expect(
      resolveNextRoute({ restaurant: { slug: 'chez-moi', is_complete: false } })
    ).toBe('/r/chez-moi/onboarding');
  });

  it('routes a complete restaurant to its slug-scoped dashboard', () => {
    expect(
      resolveNextRoute({ restaurant: { slug: 'chez-moi', is_complete: true } })
    ).toBe('/r/chez-moi/dashboard');
  });

  it('treats a missing is_complete as incomplete → onboarding', () => {
    expect(resolveNextRoute({ restaurant: { slug: 'chez-moi' } })).toBe('/r/chez-moi/onboarding');
  });

  it('returns null (contained error) for an authenticated user without a restaurant — never /login', () => {
    const route = resolveNextRoute({ restaurant: null });
    expect(route).toBeNull();
    expect(route).not.toBe('/login');
  });

  it('returns null (contained error) for a restaurant without a slug — never /login', () => {
    const route = resolveNextRoute({ restaurant: { slug: null, is_complete: true } });
    expect(route).toBeNull();
    expect(route).not.toBe('/login');
  });
});
