import logger from './logger';

/**
 * Safe wrapper for Supabase single-row queries
 * Accepts a query builder, executes with .maybeSingle(), handles edge cases
 *
 * Usage: await safeSingle(supabase.from('users').select('*').eq('id', id), 'context')
 *
 * Returns: T | null if successful
 * Throws: on error or if multiple rows found (data integrity violation)
 */
export async function safeSingle<T = any>(
  query: any, // PostgrestBuilder (from supabase.from(...).select(...))
  context: string
): Promise<T | null> {
  try {
    // Execute with maybeSingle() to safely handle 0 or 1 row
    const { data, error } = await query.maybeSingle();

    // Any error → throw (connection issue, permission, FK violation, etc)
    if (error) {
      logger.error({ context, error: error.message, code: error.code }, '❌ Database query error');
      throw error;
    }

    // 0 or 1 row (success cases)
    return data || null;
  } catch (err: any) {
    logger.error({ context, error: err?.message }, '❌ Error in safeSingle');
    throw err;
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

/**
 * Parse Postgres errors and return standardized response
 * Particularly handles UNIQUE constraint violations (23505)
 */
export interface PostgresErrorResponse {
  type: 'CONFLICT' | 'VALIDATION' | 'NOT_FOUND' | 'UNKNOWN';
  statusCode: number;
  message: string;
  detail?: string;
}

export function handlePostgresError(error: any): PostgresErrorResponse {
  // UNIQUE constraint violation
  if (error?.code === '23505') {
    return {
      type: 'CONFLICT',
      statusCode: 409,
      message: 'Resource already exists (duplicate)',
      detail: error.message,
    };
  }

  // Foreign key violation
  if (error?.code === '23503') {
    return {
      type: 'VALIDATION',
      statusCode: 400,
      message: 'Invalid reference (foreign key constraint)',
      detail: error.message,
    };
  }

  // NOT NULL violation
  if (error?.code === '23502') {
    return {
      type: 'VALIDATION',
      statusCode: 400,
      message: 'Missing required field',
      detail: error.message,
    };
  }

  // Check constraint violation
  if (error?.code === '23514') {
    return {
      type: 'VALIDATION',
      statusCode: 400,
      message: 'Invalid data (constraint violation)',
      detail: error.message,
    };
  }

  // Default unknown error
  return {
    type: 'UNKNOWN',
    statusCode: 500,
    message: 'Database error',
    detail: error?.message || 'Unknown error',
  };
}
