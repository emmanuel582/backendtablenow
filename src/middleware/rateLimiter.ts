import { Request, Response, NextFunction } from 'express';
import logger from '../lib/logger';

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

interface ClientInfo {
  count: number;
  resetTime: number;
}

class RateLimiter {
  private clients: Map<string, ClientInfo> = new Map();
  private windowMs: number;
  private maxRequests: number;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(config: RateLimitConfig) {
    this.windowMs = config.windowMs;
    this.maxRequests = config.maxRequests;
    this.startCleanupInterval();
  }

  private getClientKey(req: Request): string {
    return req.ip || req.socket.remoteAddress || 'unknown';
  }

  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, info] of this.clients.entries()) {
        if (info.resetTime < now) {
          this.clients.delete(key);
        }
      }
    }, this.windowMs);

    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      const clientKey = this.getClientKey(req);
      const now = Date.now();

      let clientInfo = this.clients.get(clientKey);

      if (!clientInfo || clientInfo.resetTime < now) {
        clientInfo = {
          count: 1,
          resetTime: now + this.windowMs,
        };
      } else {
        clientInfo.count += 1;
      }

      this.clients.set(clientKey, clientInfo);

      const resetTime = new Date(clientInfo.resetTime);
      res.setHeader('X-RateLimit-Limit', this.maxRequests.toString());
      res.setHeader('X-RateLimit-Remaining', Math.max(0, this.maxRequests - clientInfo.count).toString());
      res.setHeader('X-RateLimit-Reset', resetTime.toISOString());

      if (clientInfo.count > this.maxRequests) {
        logger.warn(
          { action: 'rate_limit_exceeded', client: clientKey, count: clientInfo.count, limit: this.maxRequests },
          'Rate limit exceeded'
        );
        return res.status(429).json({
          error: 'Too many requests',
          retryAfter: Math.ceil((clientInfo.resetTime - now) / 1000)
        });
      }

      next();
    };
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.clients.clear();
  }
}

export function createRateLimiter(config: RateLimitConfig): RateLimiter {
  return new RateLimiter(config);
}
