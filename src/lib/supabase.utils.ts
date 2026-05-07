import logger from './logger';

/**
 * Safe wrapper for .single() queries
 * Differentiates between 0 rows (normal) and multiple rows (corruption)
 *
 * Returns: T | null if successful
 * Throws: if multiple rows found (data integrity violation) or unexpected error
 */
export async function safeSingle<T>(
  query: Promise<{ data: T[] | null; error: any }>,
  context: string
): Promise<T | null> {
  try {
    const { data, error } = await query;

    // PGRST116 = 0 rows returned (normal case)
    if (error?.code === 'PGRST116') {
      return null;
    }

    // Any other error → throw (connection issue, permission, etc)
    if (error) {
      logger.error({ context, error: error.message, code: error.code }, '❌ Database query error');
      throw error;
    }

    // No data = no rows (shouldn't happen with error check above, but defensive)
    if (!data || data.length === 0) {
      return null;
    }

    // Multiple rows = data integrity violation → MUST throw, never silently return
    if (data.length > 1) {
      logger.error(
        { context, rowCount: data.length },
        '🚨 CRITICAL: Data integrity violation — multiple rows returned by single() query'
      );
      throw new Error(
        `Data integrity violation: expected 0 or 1 row, got ${data.length} rows (${context})`
      );
    }

    // Exactly 1 row → success
    return data[0];
  } catch (err: any) {
    // Re-throw if already our error, otherwise wrap
    if (err?.message?.includes('Data integrity violation')) {
      throw err;
    }
    logger.error({ context, error: err?.message }, '❌ Unexpected error in safeSingle');
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
