import { deriveProfile } from '../../lib/authBootstrap';

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
