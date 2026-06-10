import { deriveProfile } from '../../lib/authBootstrap';
import { BootstrapSchema } from '../../schemas';
import { resolveNextRoute } from '../../lib/routing';

describe('deriveProfile (/auth/bootstrap)', () => {
  it('prefers user_metadata.full_name (email/password sign-up restaurant name)', () => {
    const p = deriveProfile({
      id: 'sb-1',
      email: 'owner@bistro.fr',
      user_metadata: { full_name: 'Le Bistrot du Coin', picture: 'http://x/p.png' },
    });
    expect(p).toEqual({
      id: 'sb-1',
      email: 'owner@bistro.fr',
      name: 'Le Bistrot du Coin',
      photo: 'http://x/p.png',
    });
  });

  it('falls back to user_metadata.name (Google)', () => {
    const p = deriveProfile({ id: 'sb-2', email: 'a@b.com', user_metadata: { name: 'Chez Google' } });
    expect(p.name).toBe('Chez Google');
  });

  it('falls back to the email local part when no name metadata is present', () => {
    const p = deriveProfile({ id: 'sb-3', email: 'radwan@tablenow.io' });
    expect(p.name).toBe('radwan');
    expect(p.photo).toBeNull();
  });

  it('never returns an empty name', () => {
    const p = deriveProfile({ id: 'sb-4', email: '' });
    expect(p.name).toBe('Restaurant');
    expect(p.email).toBe('');
  });

  it('is null-safe', () => {
    expect(deriveProfile(null).name).toBe('Restaurant');
    expect(deriveProfile(undefined).id).toBe('');
  });

  it('takes avatar_url before picture for the photo', () => {
    const p = deriveProfile({
      id: 'sb-5', email: 'a@b.com',
      user_metadata: { avatar_url: 'http://x/a.png', picture: 'http://x/p.png' },
    });
    expect(p.photo).toBe('http://x/a.png');
  });
});

describe('BootstrapSchema (strict input validation)', () => {
  it('rejects a request with no access_token (→ 400)', () => {
    expect(BootstrapSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an empty access_token (→ 400)', () => {
    expect(BootstrapSchema.safeParse({ access_token: '' }).success).toBe(false);
  });

  it('rejects unknown fields (.strict())', () => {
    expect(BootstrapSchema.safeParse({ access_token: 'tok', extra: 'nope' }).success).toBe(false);
  });

  it('accepts a valid { access_token } body', () => {
    const result = BootstrapSchema.safeParse({ access_token: 'eyJhbGciOi...' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ access_token: 'eyJhbGciOi...' });
    }
  });

  it('validation errors never expose internal identifiers', () => {
    const result = BootstrapSchema.safeParse({ wrong_field: 'value' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.errors.map(e => e.message);
      for (const msg of messages) {
        expect(msg).not.toMatch(/supabase/i);
        expect(msg).not.toMatch(/postgres/i);
      }
    }
  });
});

describe('resolveNextRoute (app-state next_route)', () => {
  it('routes incomplete restaurant to /r/:slug/onboarding', () => {
    expect(resolveNextRoute({ restaurant: { slug: 'chez-marco', is_complete: false } }))
      .toBe('/r/chez-marco/onboarding');
  });

  it('routes complete restaurant to /r/:slug/dashboard', () => {
    expect(resolveNextRoute({ restaurant: { slug: 'chez-marco', is_complete: true } }))
      .toBe('/r/chez-marco/dashboard');
  });

  it('returns null when no restaurant (contained error, never /login)', () => {
    expect(resolveNextRoute({ restaurant: null })).toBeNull();
  });

  it('returns null when restaurant has no slug', () => {
    expect(resolveNextRoute({ restaurant: { slug: null, is_complete: true } })).toBeNull();
  });
});
