import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import express, { Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';

import logger from './lib/logger';
import { config } from './lib/config';
import { correlationId, errorHandler } from './middleware/handlers';

import authRoutes       from './routes/auth';
import dashboardRoutes  from './routes/dashboard';
import bookingRoutes    from './routes/bookings';
import vapiRoutes       from './routes/vapi';
import customersRoutes  from './routes/customers';
import availabilityRoutes from './routes/availability';
import emailRoutes      from './routes/email';
import calendarRoutes   from './routes/calendar';
import settingsRoutes   from './routes/settings';
import restaurantsRoutes from './routes/restaurants';
import prefillRouter    from './routes/prefill.route';
import contactRoutes    from './routes/contact';
import stripeRoutes     from './routes/stripe';
import referralRoutes from './routes/referral';
import { checkTrialEmails } from './cron/trialEmails';

const app: Application = express();
const PORT = process.env.PORT || 5000;

app.set('trust proxy', 1);

// ── Security ───────────────────────────────────────────────────────────────────────────────────────
app.use(helmet());

const allowedOrigins = [
    config.frontendUrl,
    'http://localhost:5173',
    'http://localhost:5174',
    'https://app.tablenow.io',
    'https://tablenow.io',
    'https://www.tablenow.io'
].filter(Boolean) as string[];

app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) return callback(null, origin || allowedOrigins[0]);
        callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true
}));

// ── Raw body capture ──────────────────────────────────────────────────────────────────────────────────────
// Both must be registered BEFORE express.json() so the raw Buffer is preserved.
app.use('/api/vapi/webhook', express.raw({ type: 'application/json' }), (req: Request, _res: Response, next: NextFunction) => {
    (req as any).rawBody = req.body;
    req.body = JSON.parse(req.body.toString());
    next();
});
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

// ── Middleware ────────────────────────────────────────────────────────────────────────────────────────
app.use(correlationId);
app.use(pinoHttp({ logger, useLevel: 'info' }));
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Rate limiting ──────────────────────────────────────────────────────────────────────────────────────
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false });
app.use('/api/', limiter);

// ── Health ────────────────────────────────────────────────────────────────────────────────────────
app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), version: process.env.npm_package_version });
});

// ── Routes ────────────────────────────────────────────────────────────────────────────────────────
app.use('/api/auth',         authRoutes);
app.use('/api/dashboard',    dashboardRoutes);
app.use('/api/bookings',     bookingRoutes);
app.use('/api/vapi',         vapiRoutes);
app.use('/api',              customersRoutes);
app.use('/api/availability', availabilityRoutes);
app.use('/api/email',        emailRoutes);
app.use('/api/calendar',     calendarRoutes);
app.use('/api/settings',     settingsRoutes);
app.use('/api/restaurants',  restaurantsRoutes);
app.use('/api/contact',      contactRoutes);
app.use('/api/stripe',       stripeRoutes);
app.use('/api/referral', referralRoutes);
app.use(prefillRouter);

// Backward compat: VAPI tools also reachable at /vapi/* (no rate limit)
app.use('/vapi', vapiRoutes);

// ── 404 ─────────────────────────────────────────────────────────────────────────────────────────
app.use((req: Request, res: Response) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` } });
});

// ── Unified error handler (must be last) ────────────────────────────────────────────────────────
app.use(errorHandler);

app.listen(PORT, () => {
    logger.info({ port: PORT, env: process.env.NODE_ENV, url: process.env.BACKEND_URL }, '🚀 TableNow API started');
});

// ── Trial email cron (runs in-process, every hour) ────────────────────────────────────────────────
// Skip in development with test Supabase credentials
if (process.env.NODE_ENV === 'production') {
    checkTrialEmails().catch(err => console.error('Trial email cron startup error:', err));
    setInterval(() => {
        checkTrialEmails().catch(err => console.error('Trial email cron error:', err));
    }, 60 * 60 * 1000);
}

export default app;
