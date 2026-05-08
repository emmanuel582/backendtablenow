# Backend Environment Setup

## Environment Variables

Create `.env` in the backend root with the following variables:

### Server Configuration
```
PORT=5000                          # Server port (default: 5000)
NODE_ENV=development               # Environment: development, staging, production
```

### Supabase Configuration
```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key    # Public key (VITE_SUPABASE_ANON_KEY)
SUPABASE_SERVICE_KEY=your-service-key  # Secret key (for server-side ops)
```

⚠️ **Important**: The `SUPABASE_SERVICE_KEY` is a secret. Never expose it in client code or commit it to git.

### OAuth & Authentication
```
JWT_SECRET=your-secret-key-min-32-chars
INTERNAL_SECRET=your-internal-secret-min-32-chars
FRONTEND_URL=http://localhost:3000   # For local dev; prod: https://app.tablenow.io
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
GOOGLE_REDIRECT_URI=http://localhost:5000/api/auth/google/callback
```

### Email Service (Resend)
```
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_USER=resend
SMTP_PASS=your-resend-api-key
EMAIL_FROM=info@tablenow.io
EMAIL_DOMAIN=tablenow.io
```

### AI Voice Agent (VAPI)
```
VAPI_API_KEY=your-vapi-key
VAPI_PROVISIONING_MODE=pool      # Mode for provisioning agents
```

### Database/RAG (Pinecone)
```
PINECONE_API_KEY=your-pinecone-key
PINECONE_ENVIRONMENT=us-east-1-aws
PINECONE_INDEX_NAME=tablenow-knowledge
```

### Third-party APIs
```
GOOGLE_PLACES_API_KEY=your-google-places-key
STRIPE_SECRET_KEY=sk_test_xxxx
STRIPE_PUBLISHABLE_KEY=pk_test_xxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxx
HUBSPOT_API_KEY=your-hubspot-key
GEMINI_API_KEY=your-gemini-key
BACKEND_URL=http://localhost:5000
```

## Local Development Setup

1. **Copy template** (if exists):
   ```bash
   cp .env.example .env
   ```

2. **Update with your local values**:
   - Set `PORT=5000` (or your preferred port)
   - Set `FRONTEND_URL=http://localhost:3000` or `http://localhost:5173`
   - Get Supabase credentials from your project dashboard
   - Set test values for external services (Google, VAPI, Stripe, etc.)

3. **Start the server**:
   ```bash
   npm install
   npm run dev
   ```

## Frontend Integration

The frontend calls the backend at `VITE_API_URL` (default: `https://api.tablenow.io`, or `http://localhost:5000` for local dev).

**Key endpoints** that frontend uses:
- `POST /api/auth/login` — Email/password login
- `POST /api/auth/register` — Registration
- `POST /api/auth/verify-email` — Email verification
- `POST /api/auth/google/supabase` — Google OAuth token exchange
- `GET /api/auth/me` — Get current user
- `GET /api/dashboard/*` — Dashboard data
- `POST /api/bookings` — Create booking

## Production Secrets

For production deployment, set these in your hosting platform's environment variable UI (NOT in this repo):

**Critical secrets**:
- `SUPABASE_SERVICE_KEY` — Database admin key (🔐 NEVER in git)
- `JWT_SECRET` — Session signing key (🔐 NEVER in git)
- `GOOGLE_CLIENT_SECRET` — OAuth secret (🔐 NEVER in git)
- `SMTP_PASS` — Email service key (🔐 NEVER in git)
- `VAPI_API_KEY` — Voice agent key (🔐 NEVER in git)
- `STRIPE_SECRET_KEY` — Payment key (🔐 NEVER in git)

**Non-secrets** (can be in code or env):
- `FRONTEND_URL` — User-facing domain
- `BACKEND_URL` — API domain
- `SUPABASE_URL` — Supabase project URL (public)
- `SUPABASE_ANON_KEY` — Public Supabase key (frontend also needs this)

## Common Issues

### PORT already in use
```bash
# Kill process on port 5000
lsof -i :5000 | grep LISTEN | awk '{print $2}' | xargs kill -9

# Or use different port
PORT=5001 npm run dev
```

### Database connection failed
- Verify `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are correct
- Check Supabase project is active (not paused)
- Test connection: Try querying Supabase directly

### Email not sending
- Verify `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`
- Check `EMAIL_FROM` is in allowed sender list
- Look for logs: `npm run dev 2>&1 | grep -i email`

### OAuth redirect mismatch
- Verify `GOOGLE_REDIRECT_URI` matches Google OAuth config
- For local dev: `http://localhost:5000/api/auth/google/callback`
- For prod: `https://api.tablenow.io/api/auth/google/callback`
