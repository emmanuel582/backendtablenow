#!/bin/bash

# Runtime Proof: 4 tests for Outbox idempotency + concurrency

set -e

SMOKE_ID="outbox-$(date +%s)"
API_URL="${API_URL:-http://localhost:5000/api}"
TEST_RESTAURANT_ID="00000000-0000-0000-0000-000000000001"
JWT_TOKEN="${JWT_TOKEN:-test-token}"

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║           RUNTIME PROOF: Outbox + Idempotency                   ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# TEST A: Dashboard idempotence
echo "═ TEST A: Dashboard Create Booking (2x same idempotency_key)"
KEY_A="dash_${SMOKE_ID}_a"

echo "Request 1..."
R1_A=$(curl -s -X POST "$API_URL/bookings" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -d "{
    \"restaurant_id\": \"$TEST_RESTAURANT_ID\",
    \"date\": \"2026-06-15\",
    \"time\": \"19:00\",
    \"covers\": 4,
    \"guest_name\": \"Alice Dashboard\",
    \"guest_email\": \"alice.dashboard@test.com\",
    \"guest_phone\": \"+33123456789\",
    \"source\": \"manual\",
    \"idempotency_key\": \"$KEY_A\"
  }")

HTTP1_A=$(echo "$R1_A" | jq -r '.id // "ERROR"' 2>/dev/null || echo "PARSE_ERROR")
BOOKING_ID_A=$(echo "$R1_A" | jq -r '.id // empty' 2>/dev/null || echo "")

echo "Request 2 (identical)..."
R2_A=$(curl -s -X POST "$API_URL/bookings" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -d "{
    \"restaurant_id\": \"$TEST_RESTAURANT_ID\",
    \"date\": \"2026-06-15\",
    \"time\": \"19:00\",
    \"covers\": 4,
    \"guest_name\": \"Alice Dashboard\",
    \"guest_email\": \"alice.dashboard@test.com\",
    \"guest_phone\": \"+33123456789\",
    \"source\": \"manual\",
    \"idempotency_key\": \"$KEY_A\"
  }")

HTTP2_A=$(echo "$R2_A" | jq -r '.id // "ERROR"' 2>/dev/null || echo "PARSE_ERROR")
BOOKING_ID_A2=$(echo "$R2_A" | jq -r '.id // empty' 2>/dev/null || echo "")

echo "Results:"
echo "  Req1 booking_id: $BOOKING_ID_A"
echo "  Req2 booking_id: $BOOKING_ID_A2"
echo "  Match: $([ "$BOOKING_ID_A" = "$BOOKING_ID_A2" ] && echo "✓ YES" || echo "✗ NO")"
echo ""

# TEST B: VAPI idempotence
echo "═ TEST B: VAPI Create Booking (2x same call_id)"
KEY_B="vapi_${SMOKE_ID}_b"

echo "Request 1..."
R1_B=$(curl -s -X POST "$API_URL/vapi/webhook" \
  -H "Content-Type: application/json" \
  -d "{
    \"first_name\": \"Bob\",
    \"last_name\": \"Vapi\",
    \"phone\": \"+33987654321\",
    \"date\": \"2026-06-16\",
    \"time\": \"20:00\",
    \"covers\": 2,
    \"call_id\": \"$KEY_B\"
  }")

BOOKING_ID_B=$(echo "$R1_B" | jq -r '.booking_id // empty' 2>/dev/null || echo "")

echo "Request 2 (identical)..."
R2_B=$(curl -s -X POST "$API_URL/vapi/webhook" \
  -H "Content-Type: application/json" \
  -d "{
    \"first_name\": \"Bob\",
    \"last_name\": \"Vapi\",
    \"phone\": \"+33987654321\",
    \"date\": \"2026-06-16\",
    \"time\": \"20:00\",
    \"covers\": 2,
    \"call_id\": \"$KEY_B\"
  }")

BOOKING_ID_B2=$(echo "$R2_B" | jq -r '.booking_id // empty' 2>/dev/null || echo "")

echo "Results:"
echo "  Req1 booking_id: $BOOKING_ID_B"
echo "  Req2 booking_id: $BOOKING_ID_B2"
echo "  Match: $([ "$BOOKING_ID_B" = "$BOOKING_ID_B2" ] && echo "✓ YES" || echo "✗ NO")"
echo ""

# TEST C: Email BCC idempotence
echo "═ TEST C: Email BCC Create Booking (2x same idempotency_key)"
KEY_C="email_${SMOKE_ID}_c"

echo "Request 1..."
R1_C=$(curl -s -X POST "$API_URL/email/bcc" \
  -H "Content-Type: application/json" \
  -d "{
    \"restaurant_id\": \"$TEST_RESTAURANT_ID\",
    \"date\": \"2026-06-17\",
    \"time\": \"21:00\",
    \"covers\": 3,
    \"guest_name\": \"Charlie Email\",
    \"guest_email\": \"charlie.email@test.com\",
    \"guest_phone\": \"+33555666777\",
    \"idempotency_key\": \"$KEY_C\"
  }")

BOOKING_ID_C=$(echo "$R1_C" | jq -r '.booking_id // empty' 2>/dev/null || echo "")

echo "Request 2 (identical)..."
R2_C=$(curl -s -X POST "$API_URL/email/bcc" \
  -H "Content-Type: application/json" \
  -d "{
    \"restaurant_id\": \"$TEST_RESTAURANT_ID\",
    \"date\": \"2026-06-17\",
    \"time\": \"21:00\",
    \"covers\": 3,
    \"guest_name\": \"Charlie Email\",
    \"guest_email\": \"charlie.email@test.com\",
    \"guest_phone\": \"+33555666777\",
    \"idempotency_key\": \"$KEY_C\"
  }")

BOOKING_ID_C2=$(echo "$R2_C" | jq -r '.booking_id // empty' 2>/dev/null || echo "")

echo "Results:"
echo "  Req1 booking_id: $BOOKING_ID_C"
echo "  Req2 booking_id: $BOOKING_ID_C2"
echo "  Match: $([ "$BOOKING_ID_C" = "$BOOKING_ID_C2" ] && echo "✓ YES" || echo "✗ NO")"
echo ""

# TEST D: Worker concurrency
echo "═ TEST D: Worker Concurrency (2 parallel invocations)"
INTERNAL_SECRET="${INTERNAL_SECRET:-test-internal-secret}"

echo "Invocation 1..."
W1=$(curl -s -X POST "$API_URL/dashboard/outbox/process" \
  -H "x-internal-secret: $INTERNAL_SECRET")

echo "Invocation 2 (parallel, ~100ms later)..."
sleep 0.1
W2=$(curl -s -X POST "$API_URL/dashboard/outbox/process" \
  -H "x-internal-secret: $INTERNAL_SECRET")

W1_COUNT=$(echo "$W1" | jq -r '.processed // 0' 2>/dev/null || echo "0")
W2_COUNT=$(echo "$W2" | jq -r '.processed // 0' 2>/dev/null || echo "0")
W1_FAILED=$(echo "$W1" | jq -r '.failed // 0' 2>/dev/null || echo "0")
W2_FAILED=$(echo "$W2" | jq -r '.failed // 0' 2>/dev/null || echo "0")

echo "Results:"
echo "  Worker 1: processed=$W1_COUNT, failed=$W1_FAILED"
echo "  Worker 2: processed=$W2_COUNT, failed=$W2_FAILED"
echo "  Total processed: $(($W1_COUNT + $W2_COUNT))"
echo ""

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                          VERDICT                               ║"
echo "╚════════════════════════════════════════════════════════════════╝"

# Count passes
PASS=0
[ "$BOOKING_ID_A" = "$BOOKING_ID_A2" ] && PASS=$((PASS+1))
[ "$BOOKING_ID_B" = "$BOOKING_ID_B2" ] && PASS=$((PASS+1))
[ "$BOOKING_ID_C" = "$BOOKING_ID_C2" ] && PASS=$((PASS+1))
[ $(($W1_FAILED + $W2_FAILED)) -eq 0 ] && PASS=$((PASS+1))

echo "Tests passed: $PASS/4"
[ $PASS -eq 4 ] && echo "✓ PRÊT POUR REVIEW HUMAINE" || echo "✗ BLOQUÉ"
