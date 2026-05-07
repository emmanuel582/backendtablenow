import type { PostgrestSingleResponse } from '@supabase/supabase-js';

/**
 * Safe wrapper for Supabase single-row queries
 * Expects a builder with .maybeSingle() already called
 *
 * Usage: await safeSingle(supabase.from('users').select('*').eq('id', id).maybeSingle())
 *
 * Returns: T | null if successful
 * Throws: on database error
 */
export async function safeSingle<T>(
  query: PromiseLike<PostgrestSingleResponse<T>>
): Promise<T | null> {
  const { data, error } = await query;

  if (error) {
    throw error;
  }

  return data ?? null;
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
