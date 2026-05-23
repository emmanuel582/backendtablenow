// ============================================
// Error Tracking Service — Actionable Errors
//
// Structured error logging with context:
//   - what failed
//   - why it failed
//   - what action to take
//   - who is affected
//
// Enables alerting and debugging.
// ============================================

import logger from '../lib/logger';

export type ErrorSeverity = 'critical' | 'error' | 'warning' | 'info';
export type ErrorCategory =
  | 'auth'
  | 'booking'
  | 'availability'
  | 'voice'
  | 'provider'
  | 'database'
  | 'validation'
  | 'rate_limit'
  | 'unknown';

interface ErrorContext {
  user_id?: string;
  restaurant_id?: string;
  booking_id?: string;
  call_id?: string;
  request_id?: string;
  [key: string]: unknown;
}

interface ErrorMetadata {
  error_code: string;
  error_message: string;
  error_category: ErrorCategory;
  severity: ErrorSeverity;
  user_facing_message: string;
  suggested_action: string;
  timestamp: string;
  context: ErrorContext;
  stack?: string;
  retry_safe: boolean;
  alert: boolean;
}

class ErrorTrackingService {
  // Log structured error with actionable context
  trackError(input: {
    error: Error | string;
    category: ErrorCategory;
    severity: ErrorSeverity;
    userFacingMessage: string;
    suggestedAction: string;
    context?: ErrorContext;
    retrySafe?: boolean;
    shouldAlert?: boolean;
  }): ErrorMetadata {
    const errorMsg = input.error instanceof Error ? input.error.message : input.error;
    const stack = input.error instanceof Error ? input.error.stack : undefined;

    const metadata: ErrorMetadata = {
      error_code: this.generateErrorCode(input.category, input.severity),
      error_message: errorMsg,
      error_category: input.category,
      severity: input.severity,
      user_facing_message: input.userFacingMessage,
      suggested_action: input.suggestedAction,
      timestamp: new Date().toISOString(),
      context: input.context || {},
      stack: this.sanitizeStack(stack),
      retry_safe: input.retrySafe ?? false,
      alert: input.shouldAlert ?? input.severity === 'critical',
    };

    const logLevel = this.getLogLevel(input.severity);
    const logFn = logLevel === 'error' ? logger.error : logLevel === 'warn' ? logger.warn : logger.info;

    logFn(
      {
        error_code: metadata.error_code,
        error_message: metadata.error_message,
        error_category: metadata.error_category,
        severity: metadata.severity,
        user_facing_message: metadata.user_facing_message,
        suggested_action: metadata.suggested_action,
        retry_safe: metadata.retry_safe,
        alert: metadata.alert,
        context: metadata.context,
        stack: metadata.stack,
      },
      `error.${input.category}`
    );

    return metadata;
  }

  // Booking-specific errors
  bookingCreationFailed(input: {
    restaurant_id: string;
    reason: string;
    call_id?: string;
  }): ErrorMetadata {
    return this.trackError({
      error: new Error(input.reason),
      category: 'booking',
      severity: 'error',
      userFacingMessage: 'Could not create booking. Please try again or call the restaurant.',
      suggestedAction: 'Retry booking creation or escalate to restaurant support',
      context: {
        restaurant_id: input.restaurant_id,
        call_id: input.call_id,
      },
      retrySafe: true,
      shouldAlert: false,
    });
  }

  availabilityCheckFailed(input: {
    restaurant_id: string;
    reason: string;
    call_id?: string;
  }): ErrorMetadata {
    return this.trackError({
      error: new Error(input.reason),
      category: 'availability',
      severity: 'warning',
      userFacingMessage: 'Could not check availability. Using fallback times.',
      suggestedAction: 'Check calendar integration status',
      context: {
        restaurant_id: input.restaurant_id,
        call_id: input.call_id,
      },
      retrySafe: true,
      shouldAlert: false,
    });
  }

  voiceProviderError(input: {
    provider: 'vapi' | 'openai' | 'twilio';
    reason: string;
    call_id?: string;
  }): ErrorMetadata {
    return this.trackError({
      error: new Error(`${input.provider} provider error: ${input.reason}`),
      category: 'provider',
      severity: 'critical',
      userFacingMessage: 'Voice system encountered an issue. Transferring to restaurant staff.',
      suggestedAction: `Check ${input.provider} integration and credentials`,
      context: {
        provider: input.provider,
        call_id: input.call_id,
      },
      retrySafe: false,
      shouldAlert: true,
    });
  }

  authenticationFailed(input: {
    user_id?: string;
    reason: string;
  }): ErrorMetadata {
    return this.trackError({
      error: new Error(input.reason),
      category: 'auth',
      severity: 'error',
      userFacingMessage: 'Authentication failed. Please login again.',
      suggestedAction: 'Clear cookies and re-authenticate, or check CORS settings',
      context: {
        user_id: input.user_id,
      },
      retrySafe: false,
      shouldAlert: false,
    });
  }

  databaseError(input: {
    operation: string;
    reason: string;
    restaurant_id?: string;
  }): ErrorMetadata {
    return this.trackError({
      error: new Error(`Database ${input.operation} failed: ${input.reason}`),
      category: 'database',
      severity: 'critical',
      userFacingMessage: 'Database error. Please retry or contact support.',
      suggestedAction: `Check database connection and logs for operation: ${input.operation}`,
      context: {
        operation: input.operation,
        restaurant_id: input.restaurant_id,
      },
      retrySafe: true,
      shouldAlert: true,
    });
  }

  validationFailed(input: {
    field: string;
    reason: string;
    value?: unknown;
  }): ErrorMetadata {
    return this.trackError({
      error: new Error(`Validation failed for ${input.field}: ${input.reason}`),
      category: 'validation',
      severity: 'warning',
      userFacingMessage: `Invalid input: ${input.reason}`,
      suggestedAction: 'Fix input and retry',
      context: {
        field: input.field,
        value_type: typeof input.value,
      },
      retrySafe: false,
      shouldAlert: false,
    });
  }

  rateLimitExceeded(input: {
    restaurant_id: string;
    limit_type: 'voice_calls' | 'api_requests' | 'bookings';
  }): ErrorMetadata {
    return this.trackError({
      error: new Error(`Rate limit exceeded: ${input.limit_type}`),
      category: 'rate_limit',
      severity: 'warning',
      userFacingMessage: 'Too many requests. Please wait and try again.',
      suggestedAction: `Check ${input.limit_type} rate limits and upgrade plan if needed`,
      context: {
        restaurant_id: input.restaurant_id,
        limit_type: input.limit_type,
      },
      retrySafe: true,
      shouldAlert: true,
    });
  }

  // Helpers

  private generateErrorCode(category: ErrorCategory, severity: ErrorSeverity): string {
    const now = Date.now();
    const categoryPrefix = category.substring(0, 3).toUpperCase();
    const severityPrefix = severity.substring(0, 1).toUpperCase();
    return `${categoryPrefix}${severityPrefix}${now.toString(36).toUpperCase()}`;
  }

  private getLogLevel(severity: ErrorSeverity): string {
    const levelMap = {
      critical: 'error',
      error: 'error',
      warning: 'warn',
      info: 'info',
    };
    return levelMap[severity] || 'info';
  }

  private sanitizeStack(stack?: string): string | undefined {
    if (!stack) return undefined;
    // Remove sensitive file paths, but keep enough for debugging
    return stack
      .split('\n')
      .map(line => {
        // Keep structure but remove full paths
        return line.replace(/\/home\/.*?\//g, '...');
      })
      .join('\n');
  }
}

export default new ErrorTrackingService();
