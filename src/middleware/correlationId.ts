/**
 * Correlation ID Middleware
 * Ensures every request has a unique correlation ID for tracking across logs
 */

import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction) {
    // Use existing correlation ID from header or generate a new one
    const correlationId = req.headers['x-correlation-id'] as string || uuidv4();

    // Store in request for use in handlers
    req.id = correlationId;

    // Add to response headers
    res.setHeader('X-Correlation-ID', correlationId);

    next();
}
