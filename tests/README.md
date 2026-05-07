## Staging Tests

### Quick Start

**Smoke tests (shell script — quick validation):**
```bash
BACKEND_URL=http://localhost:5000 bash tests/staging-smoke-test.sh
```

**Full integration tests (Jest):**
```bash
npm test tests/integration/
```

### Test Coverage

#### 1. **Bookings Integration Tests** (`bookings.test.ts`)
- ✅ Manual booking creation (POST /api/bookings)
- ✅ Validation error handling (invalid email, date, time)
- ✅ **Idempotency test**: Double-click protection (same payload = same booking)
- ✅ Booking retrieval (GET /api/bookings/:id)
- ✅ List bookings with pagination & filters
- ✅ Booking updates (PUT)
- ✅ Booking cancellation (DELETE)

#### 2. **Auth Validation Tests** (`auth.test.ts`)
- ✅ Register: email, password, required fields validation
- ✅ Login: email & password validation
- ✅ Email verification: token validation
- ✅ Google OAuth: access_token validation
- ✅ Error response format: correlationId, error codes

#### 3. **Smoke Tests** (`staging-smoke-test.sh`)
- ✅ Health check
- ✅ Auth validation (quick)
- ✅ Booking validation (quick)
- ✅ Error response format

### Critical Tests for Data Integrity

**Idempotency Test (prevents double bookings):**
```typescript
// First request
POST /api/bookings { guestName: "John", date: "2026-05-20", time: "19:30", phone: "+33612345678", ... }
→ Response: { booking_id: "abc123" }

// Second request (same payload)
POST /api/bookings { guestName: "John", date: "2026-05-20", time: "19:30", phone: "+33612345678", ... }
→ Response: { booking_id: "abc123" } // SAME ID, not duplicate!
```

### Running Tests on Staging

1. **Start backend:**
   ```bash
   npm start
   ```

2. **In another terminal, run tests:**
   ```bash
   # Option A: Smoke tests (30 seconds)
   BACKEND_URL=http://localhost:5000 bash tests/staging-smoke-test.sh

   # Option B: Full integration tests (2-3 minutes)
   npm test tests/integration/bookings.test.ts
   npm test tests/integration/auth.test.ts
   ```

### Environment Variables for Tests

```bash
BACKEND_URL=http://localhost:5000        # Backend URL (default: localhost:5000)
TEST_AUTH_TOKEN=eyJ0eXAi...              # JWT token for authenticated endpoints
TEST_RESTAURANT_ID=uuid-of-test-restaurant  # Optional restaurant UUID
DEBUG=true                                 # Show console logs during tests
```

### Expected Results

All tests should pass with these signatures:
- Validation errors: HTTP 400 + VALIDATION_ERROR code
- Idempotency: Same booking ID returned on duplicate request
- Authentication: HTTP 401 for invalid credentials
- Success: HTTP 200-201 with proper response format

### Troubleshooting

**Tests fail with "ECONNREFUSED":**
- Backend not running. Start with `npm start`

**Tests fail with "401 Unauthorized":**
- `TEST_AUTH_TOKEN` not set or expired. Generate valid JWT and set env var.

**Idempotency test fails:**
- Check if UNIQUE constraint was applied: `SELECT * FROM pg_indexes WHERE tablename='bookings'`
- If missing, run migration: `ALTER TABLE bookings ADD CONSTRAINT ... UNIQUE(...)`

**Validation not working:**
- Verify Zod schemas are applied in handlers. Check middleware setup in server.ts
