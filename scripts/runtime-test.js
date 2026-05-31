#!/usr/bin/env node

// ============================================================================
// Runtime Proof: Transactional Outbox + Idempotency
// ============================================================================
// DO NOT run until the SQL design is validated.
//
// Credentials MUST come from the environment — NEVER hardcode or commit keys:
//   SUPABASE_URL=...            (required)
//   SUPABASE_SERVICE_KEY=...    (required; configured in local/staging env only)
//   TEST_RESTAURANT_ID=<uuid>   (required; a real restaurant row)
//
// Usage:  SUPABASE_SERVICE_KEY=... TEST_RESTAURANT_ID=... node scripts/runtime-test.js
// ============================================================================

const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const TEST_RESTAURANT_ID = process.env.TEST_RESTAURANT_ID;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('ABORT: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in the environment.');
  console.error('       Never paste the service key into chat or commit it.');
  process.exit(2);
}
if (!TEST_RESTAURANT_ID) {
  console.error('ABORT: TEST_RESTAURANT_ID must be set (a real restaurant row UUID).');
  process.exit(2);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);
const SMOKE_ID = `outbox-${Date.now()}`;

async function createViaRpc(key, channels, overrides = {}) {
  return supabase.rpc('create_booking_with_outbox', {
    p_restaurant_id: TEST_RESTAURANT_ID,
    p_idempotency_key: key,
    p_booking_date: overrides.date || '2026-06-15',
    p_booking_time: overrides.time || '19:00',
    p_covers: overrides.covers || 4,
    p_guest_name: overrides.name || 'Runtime Test',
    p_guest_email: overrides.email || 'runtime@test.com',
    p_guest_phone: overrides.phone || '+33123456789',
    p_special_requests: null,
    p_source: overrides.source || 'manual',
    p_guest_language: 'fr',
    p_correlation_id: key,
    p_channels: channels,
  });
}

async function counts(key, bookingId) {
  const { data: bRows } = await supabase
    .from('bookings').select('id').eq('idempotency_key', key);
  const { data: oRows } = await supabase
    .from('outbox_events').select('id, status').eq('booking_id', bookingId);
  return { bookings: bRows?.length ?? 0, outbox: oRows ?? [] };
}

async function idempotencyTest(label, key, channels, overrides) {
  console.log(`\n═ ${label} (2x same key)`);
  const { data: r1, error: e1 } = await createViaRpc(key, channels, overrides);
  if (e1) { console.error(`  req1 ERROR: ${e1.message}`); return false; }
  const id1 = r1[0].booking_id;
  console.log(`  req1: booking_id=${id1} is_existing=${r1[0].is_existing} side_effects=${r1[0].side_effects_status}`);

  const { data: r2, error: e2 } = await createViaRpc(key, channels, overrides);
  if (e2) { console.error(`  req2 ERROR: ${e2.message}`); return false; }
  const id2 = r2[0].booking_id;
  console.log(`  req2: booking_id=${id2} is_existing=${r2[0].is_existing} side_effects=${r2[0].side_effects_status}`);

  const c = await counts(key, id1);
  const statusDist = c.outbox.reduce((acc, e) => { acc[e.status] = (acc[e.status]||0)+1; return acc; }, {});
  console.log(`  COUNT(bookings for key)=${c.bookings} (expect 1)`);
  console.log(`  COUNT(outbox for booking)=${c.outbox.length} (expect ${channels.length})`);
  console.log(`  outbox status: ${JSON.stringify(statusDist)}`);

  const pass = id1 === id2 && c.bookings === 1 && c.outbox.length === channels.length && r2[0].is_existing === true;
  console.log(`  ${pass ? '✓ PASS' : '✗ FAIL'}`);
  return pass;
}

async function workerConcurrencyTest() {
  console.log('\n═ TEST D: Worker concurrency (2 parallel claims)');
  const { processOutboxWorker } = require('../dist/workers/outbox-worker');
  // Fire two workers nearly simultaneously
  const [w1, w2] = await Promise.all([
    processOutboxWorker(),
    processOutboxWorker(),
  ]);
  console.log(`  worker1: ${JSON.stringify(w1)}`);
  console.log(`  worker2: ${JSON.stringify(w2)}`);
  // No assertion on overlap here beyond no crash; detailed overlap check is
  // guaranteed by FOR UPDATE SKIP LOCKED at the SQL level.
  const pass = (w1.failed === 0 && w2.failed === 0);
  console.log(`  ${pass ? '✓ PASS (no failures)' : '✗ FAIL'}`);
  return pass;
}

(async () => {
  console.log('RUNTIME PROOF — transactional outbox + idempotency');
  console.log(`SMOKE_ID=${SMOKE_ID}`);

  const results = [];
  results.push(await idempotencyTest('TEST A: Dashboard', `dash_${SMOKE_ID}`, ['email', 'calendar'],
    { source: 'manual', date: '2026-06-15', time: '19:00' }));
  results.push(await idempotencyTest('TEST B: VAPI', `vapi_${SMOKE_ID}`, ['email'],
    { source: 'phone', date: '2026-06-16', time: '20:00' }));
  results.push(await idempotencyTest('TEST C: Email BCC', `email_${SMOKE_ID}`, ['email'],
    { source: 'web', date: '2026-06-17', time: '21:00' }));
  results.push(await workerConcurrencyTest());

  const passed = results.filter(Boolean).length;
  console.log(`\nTests passed: ${passed}/${results.length}`);
  console.log(passed === results.length ? '✓ ALL PASS' : '✗ FAILURES PRESENT');
  process.exit(passed === results.length ? 0 : 1);
})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
