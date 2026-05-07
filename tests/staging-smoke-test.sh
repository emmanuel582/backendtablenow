#!/bin/bash

###############################################################################
# Staging Smoke Test — validates core flows
# Usage: bash tests/staging-smoke-test.sh
# Environment: Set BACKEND_URL, TEST_AUTH_TOKEN before running
###############################################################################

set -e

BACKEND_URL="${BACKEND_URL:-http://localhost:5000}"
TEST_AUTH_TOKEN="${TEST_AUTH_TOKEN:-}"
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Counters
PASSED=0
FAILED=0

echo "🚀 TableNow Staging Smoke Tests"
echo "Backend: $BACKEND_URL"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ─── Helper: HTTP call + assert ──────────────────────────────────────────────
test_endpoint() {
  local name="$1"
  local method="$2"
  local endpoint="$3"
  local body="$4"
  local expected_status="$5"

  echo -n "Testing: $name... "

  if [ -z "$body" ]; then
    response=$(curl -s -w "\n%{http_code}" -X "$method" \
      -H "Authorization: Bearer $TEST_AUTH_TOKEN" \
      "$BACKEND_URL$endpoint")
  else
    response=$(curl -s -w "\n%{http_code}" -X "$method" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $TEST_AUTH_TOKEN" \
      -d "$body" \
      "$BACKEND_URL$endpoint")
  fi

  http_code=$(echo "$response" | tail -n1)
  body=$(echo "$response" | head -n-1)

  if [[ "$http_code" == "$expected_status" ]]; then
    echo -e "${GREEN}✓ PASS${NC} (HTTP $http_code)"
    PASSED=$((PASSED + 1))
    echo "$body"
  else
    echo -e "${RED}✗ FAIL${NC} (expected $expected_status, got $http_code)"
    FAILED=$((FAILED + 1))
    echo "Response: $body"
  fi

  echo ""
}

# ─── Test 1: Health check ──────────────────────────────────────────────────
echo -e "${YELLOW}1. HEALTH CHECK${NC}"
test_endpoint "Health endpoint" "GET" "/health" "" "200"

# ─── Test 2: Auth Validation ──────────────────────────────────────────────
echo -e "${YELLOW}2. AUTH VALIDATION${NC}"
test_endpoint "Register: invalid email" "POST" "/api/auth/register" \
  '{"email":"invalid","password":"Password123","restaurantName":"Test","ownerName":"Owner"}' "400"

test_endpoint "Register: short password" "POST" "/api/auth/register" \
  '{"email":"test@example.com","password":"short","restaurantName":"Test","ownerName":"Owner"}' "400"

test_endpoint "Login: invalid email" "POST" "/api/auth/login" \
  '{"email":"invalid","password":"Pass123"}' "400"

test_endpoint "VerifyEmail: missing token" "POST" "/api/auth/verify-email" \
  '{}' "400"

# ─── Test 3: Booking Validation ────────────────────────────────────────────
echo -e "${YELLOW}3. BOOKING VALIDATION${NC}"

if [ -n "$TEST_AUTH_TOKEN" ]; then
  test_endpoint "Booking: invalid email" "POST" "/api/bookings" \
    '{"guestName":"Test","guestEmail":"invalid","guestPhone":"+33612345678","date":"2026-05-20","time":"19:30","partySize":2}' "400"

  test_endpoint "Booking: invalid date" "POST" "/api/bookings" \
    '{"guestName":"Test","guestEmail":"test@example.com","guestPhone":"+33612345678","date":"2026-5-20","time":"19:30","partySize":2}' "400"

  test_endpoint "Booking: invalid time" "POST" "/api/bookings" \
    '{"guestName":"Test","guestEmail":"test@example.com","guestPhone":"+33612345678","date":"2026-05-20","time":"19:30:00","partySize":2}' "400"
else
  echo -e "${YELLOW}⚠️  Skipping booking tests (no TEST_AUTH_TOKEN)${NC}"
fi

# ─── Test 4: Error Response Format ────────────────────────────────────────
echo -e "${YELLOW}4. ERROR RESPONSE FORMAT${NC}"

response=$(curl -s -X POST \
  -H "Content-Type: application/json" \
  -d '{"email":"invalid"}' \
  "$BACKEND_URL/api/auth/register")

if echo "$response" | grep -q "correlationId"; then
  echo -e "${GREEN}✓ PASS${NC} Error responses include correlationId"
  PASSED=$((PASSED + 1))
else
  echo -e "${RED}✗ FAIL${NC} Error responses missing correlationId"
  FAILED=$((FAILED + 1))
fi

if echo "$response" | grep -q "VALIDATION_ERROR"; then
  echo -e "${GREEN}✓ PASS${NC} Error responses include error code"
  PASSED=$((PASSED + 1))
else
  echo -e "${RED}✗ FAIL${NC} Error responses missing error code"
  FAILED=$((FAILED + 1))
fi

echo ""

# ─── Summary ───────────────────────────────────────────────────────────────
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "Tests passed: ${GREEN}$PASSED${NC}"
echo -e "Tests failed: ${RED}$FAILED${NC}"

if [ $FAILED -eq 0 ]; then
  echo -e "\n${GREEN}✅ All smoke tests passed!${NC}"
  exit 0
else
  echo -e "\n${RED}❌ Some tests failed${NC}"
  exit 1
fi
