import pino, { Logger as PinoLogger } from 'pino';

/**
 * Structured Logging with Pino
 * Configuration:
 * - Production: JSON format for log aggregation
 * - Development: Pretty-printed for readability
 * - Fields logged: correlationId, action, duration, status
 * - Fields NEVER logged: tokens, passwords, full PII
 */

const logger = pino({
    level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
    ...(process.env.NODE_ENV !== 'production' && {
        transport: {
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'SYS:standard',
                ignore: 'pid,hostname',
                singleLine: false
            }
        }
    }),
    base: {
        service: 'tablenow-api',
        env: process.env.NODE_ENV || 'development',
        version: process.env.APP_VERSION || '1.0.0'
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
        err: pino.stdSerializers.err,
        req: (req: any) => ({
            method: req.method,
            url: req.url,
            path: req.path,
            correlationId: req.headers?.['x-correlation-id'] || req.id,
            ip: req.ip || req.headers?.['x-forwarded-for']
        }),
        res: (res: any) => ({
            statusCode: res.statusCode,
            responseTime: res.responseTime
        })
    }
});

/**
 * Helper: Log action with timing
 * Usage: const stopTimer = logActionStart('booking_create', { restaurant_id, source });
 *        stopTimer({ booking_id, status: 'success' });
 */
export function logActionStart(action: string, context?: Record<string, unknown>) {
    const startTime = Date.now();
    return (result?: Record<string, unknown>, error?: Error) => {
        const duration = Date.now() - startTime;
        if (error) {
            logger.error({ action, ...context, ...result, duration, error }, `${action} failed`);
        } else {
            logger.info({ action, ...context, ...result, duration }, `${action} completed`);
        }
    };
}

/**
 * Helper: Sanitize sensitive fields before logging
 */
export function sanitizeForLogging(data: any): any {
    if (!data || typeof data !== 'object') return data;
    const sanitized = { ...data };
    const sensitiveFields = [
        'access_token', 'refresh_token', 'authorization',
        'api_key', 'secret', 'password',
        'credit_card', 'ssn', 'pii'
    ];
    for (const field of sensitiveFields) {
        if (field in sanitized) {
            sanitized[field] = '[REDACTED]';
        }
    }
    return sanitized;
}

export default logger;
export type Logger = PinoLogger;
