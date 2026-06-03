// Pure, side-effect-free helpers for the /auth/bootstrap endpoint. Kept out of
// routes/auth.ts so they can be unit-tested without importing the Supabase client
// (which requires runtime env vars).

export interface SupabaseUserBody {
  id?: string;
  email?: string;
  user_metadata?: {
    full_name?: string;
    name?: string;
    avatar_url?: string;
    picture?: string;
  } | null;
}

export interface DerivedProfile {
  id: string;
  email: string;
  name: string;
  photo: string | null;
}

// Derive a restaurant-ready profile from a Supabase Auth user. Provider-agnostic:
// Google fills user_metadata.full_name/picture; email/password sign-up carries the
// restaurant name we pass in options.data.full_name. Falls back to the email local
// part, then a generic label, so name is never empty.
export function deriveProfile(body: SupabaseUserBody | null | undefined): DerivedProfile {
  const email = body?.email?.trim() || '';
  const meta = body?.user_metadata || {};
  const name =
    (meta.full_name && meta.full_name.trim()) ||
    (meta.name && meta.name.trim()) ||
    (email ? email.split('@')[0] : '') ||
    'Restaurant';
  const photo = meta.avatar_url || meta.picture || null;
  return { id: body?.id || '', email, name, photo };
}
