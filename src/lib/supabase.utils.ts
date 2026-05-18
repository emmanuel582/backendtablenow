import logger from './logger';

export interface SafeSingleResult<T> {
  data: T | null;
  error: string | null;
  isDuplicate: boolean;
}

export async function safeSingle<T>(
  query: Promise<{ data: T[] | null; error: any }> | PromiseLike<{ data: T[] | null; error: any }>,
  context: string
): Promise<SafeSingleResult<T>> {
  try {
    const { data, error } = await query;

    if (error) {
      if (error.code === 'PGRST116') {
        logger.warn({ context, code: error.code }, '⚠️ Multiple rows returned by single() query');
        return { data: null, error: 'Multiple records found (data integrity issue)', isDuplicate: true };
      }
      logger.error({ context, error: error.message }, '❌ Supabase query error');
      return { data: null, error: error.message, isDuplicate: false };
    }

    if (!data || data.length === 0) {
      return { data: null, error: null, isDuplicate: false };
    }

    if (data.length > 1) {
      logger.warn({ context, count: data.length }, '⚠️ Unexpected multiple rows without PGRST116');
      return { data: data[0], error: 'Multiple records found', isDuplicate: true };
    }

    return { data: data[0], error: null, isDuplicate: false };
  } catch (err: any) {
    logger.error({ context, err: err?.message }, '❌ Unexpected error in safeSingle');
    return { data: null, error: err?.message || 'Unknown error', isDuplicate: false };
  }
}

export function generateUniqueSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50) || 'unnamed';
}

export function generateSlugWithFallback(name: string): string {
  const slug = generateUniqueSlug(name);
  return slug || `resto-${Date.now().toString(36).slice(-6)}`;
}
