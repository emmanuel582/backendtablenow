/**
 * Validation Middleware
 * Validates request body against a Zod schema
 * Returns structured error response with correlationId
 */

import { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';
import logger from '../lib/logger';

export function validateBody(schema: ZodSchema) {
    return async (req: Request, res: Response, next: NextFunction) => {
        const correlationId = req.headers['x-correlation-id'] as string || req.id;

        try {
            // Parse and validate body
            const validated = await schema.parseAsync(req.body);
            // Replace body with validated data (strips unknown fields if not using .strict())
            req.body = validated;
            next();
        } catch (error: any) {
            logger.warn(
                {
                    correlationId,
                    action: 'validation_error',
                    path: req.path,
                    method: req.method,
                    errors: error.errors?.map((e: any) => ({
                        path: e.path.join('.'),
                        message: e.message,
                        code: e.code
                    }))
                },
                'Request validation failed'
            );

            res.status(400).json({
                error: 'VALIDATION_ERROR',
                message: 'Request validation failed',
                correlationId,
                details: error.errors?.map((e: any) => ({
                    path: e.path.join('.'),
                    message: e.message
                })) || [{ message: error.message }]
            });
        }
    };
}

/**
 * Validate query parameters
 */
export function validateQuery(schema: ZodSchema) {
    return async (req: Request, res: Response, next: NextFunction) => {
        const correlationId = req.headers['x-correlation-id'] as string || req.id;

        try {
            const validated = await schema.parseAsync(req.query);
            req.query = validated as any;
            next();
        } catch (error: any) {
            logger.warn(
                {
                    correlationId,
                    action: 'query_validation_error',
                    path: req.path,
                    errors: error.errors?.map((e: any) => ({
                        path: e.path.join('.'),
                        message: e.message
                    }))
                },
                'Query validation failed'
            );

            res.status(400).json({
                error: 'VALIDATION_ERROR',
                message: 'Query validation failed',
                correlationId,
                details: error.errors?.map((e: any) => ({
                    path: e.path.join('.'),
                    message: e.message
                })) || [{ message: error.message }]
            });
        }
    };
}

/**
 * Validate path parameters
 */
export function validateParams(schema: ZodSchema) {
    return async (req: Request, res: Response, next: NextFunction) => {
        const correlationId = req.headers['x-correlation-id'] as string || req.id;

        try {
            const validated = await schema.parseAsync(req.params);
            req.params = validated as any;
            next();
        } catch (error: any) {
            logger.warn(
                {
                    correlationId,
                    action: 'params_validation_error',
                    path: req.path,
                    errors: error.errors?.map((e: any) => ({
                        path: e.path.join('.'),
                        message: e.message
                    }))
                },
                'Path parameter validation failed'
            );

            res.status(400).json({
                error: 'VALIDATION_ERROR',
                message: 'Path parameter validation failed',
                correlationId,
                details: error.errors?.map((e: any) => ({
                    path: e.path.join('.'),
                    message: e.message
                })) || [{ message: error.message }]
            });
        }
    };
}
