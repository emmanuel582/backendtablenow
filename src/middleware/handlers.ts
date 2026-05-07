import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';
import crypto from 'crypto';
import { AppError, ValidationError } from '../lib/errors';
import logger from '../lib/logger';

// ─── Async Handler Wrapper ────────────────────────────────────────────────────
// Eliminates repetitive try-catch blocks in route handlers
// Catches Promise rejections and passes to errorHandler middleware

export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) {
    return (req: Request, res: Response, next: NextFunction) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

// ─── Correlation ID ───────────────────────────────────────────────────────────

export function correlationId(req: Request, res: Response, next: NextFunction) {
    const id = (req.headers['x-correlation-id'] as string) || crypto.randomUUID();
    req.headers['x-correlation-id'] = id;
    res.setHeader('x-correlation-id', id);
    (req as any).correlationId = id;
    next();
}

// ─── Zod Validation ───────────────────────────────────────────────────────────

export function validate(schema: ZodSchema, source: 'body' | 'query' | 'params' = 'body') {
    return (req: Request, res: Response, next: NextFunction) => {
        const result = schema.safeParse(req[source]);
        if (!result.success) {
            const formatted = result.error.errors.map(e => ({
                field: e.path.join('.'),
                message: e.message
            }));
            return next(new ValidationError('Validation failed', formatted));
        }
        req[source] = result.data;
        next();
    };
}

// ─── VAPI Webhook HMAC ────────────────────────────────────────────────────────
// Verifies that the webhook is genuinely from VAPI using HMAC-SHA256

export function vapiWebhookAuth(req: Request, res: Response, next: NextFunction) {
    const secret = process.env.VAPI_WEBHOOK_SECRET;

    // If no secret configured, skip (dev mode or VAPI doesn't send signature)
    if (!secret) {
        logger.warn({ path: req.path }, 'VAPI_WEBHOOK_SECRET not set — skipping HMAC verification');
        return next();
    }

    const signature = req.headers['x-vapi-signature'] as string;
    if (!signature) {
        logger.warn({ path: req.path }, 'VAPI webhook received without signature');
        return res.status(401).json({ error: 'Missing webhook signature' });
    }

    const rawBody = (req as any).rawBody;
    if (!rawBody) {
        return next(); // rawBody middleware not enabled, skip
    }

    const expected = crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        logger.warn({ path: req.path }, 'VAPI webhook HMAC mismatch — rejected');
        return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    next();
}

// ─── Unified Error Handler ────────────────────────────────────────────────────

export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction) {
    const correlationId = (req as any).correlationId;

    if (err instanceof AppError) {
        logger.warn({ correlationId, code: (err as AppError).code, statusCode: (err as AppError).statusCode, path: req.path, details: (err as AppError).details }, err.message);

        return res.status(err.statusCode).json({
            error: {
                code: err.code,
                message: err.message,
                ...(err.details ? { details: err.details as object } : {}),
                correlationId
            }
        });
    }

    if (err instanceof ZodError) {
        return res.status(400).json({
            error: {
                code: 'VALIDATION_ERROR',
                message: 'Validation failed',
                details: err.errors,
                correlationId
            }
        });
    }

    // Unexpected errors
    logger.error({ correlationId, err, path: req.path }, 'Unhandled error');
    res.status(500).json({
        error: {
            code: 'INTERNAL_ERROR',
            message: 'An unexpected error occurred',
            correlationId
        }
    });
}
