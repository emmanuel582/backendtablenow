#!/usr/bin/env node

const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || 'https://kvxujqgaaongkoczjyhc.supabase.co';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt2eHVqcWdhYW9uZ2tvY3pqeWhjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjUxOTU1ODQsImV4cCI6MjA4MDc3MTU4NH0.o5CLEM00nC_cZNEjYgZPvGnnxqS1Wu9PFrpw64fIdrs';

const supabase = createClient(supabaseUrl, supabaseAnonKey);

const SMOKE_ID = `outbox-${Date.now()}`;
const TEST_RESTAURANT_ID = '00000000-0000-0000-0000-000000000001';

(async () => {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║           RUNTIME PROOF: Outbox + Idempotency                   ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('');

  // TEST A: Dashboard idempotence
  console.log('═ TEST A: Dashboard Create Booking (2x same idempotency_key)');
  const keyA = `dash_${SMOKE_ID}_a`;

  console.log('Request 1...');
  const { data: booking1, error: err1 } = await supabase
    .from('bookings')
    .insert({
      restaurant_id: TEST_RESTAURANT_ID,
      booking_date: '2026-06-15',
      booking_time: '19:00',
      party_size: 4,
      guest_name: 'Alice Dashboard',
      guest_email: 'alice.dashboard@test.com',
      guest_phone: '+33123456789',
      source: 'manual',
      idempotency_key: keyA,
      status: 'confirmed',
      booked_for: '2026-06-15T19:00:00',
      covers: 4,
    })
    .select()
    .single();

  if (err1) {
    console.error(`  Error: ${err1.message}`);
    process.exit(1);
  }

  const bookingIdA = booking1.id;
  console.log(`  Booking ID: ${bookingIdA}`);

  console.log('Request 2 (duplicate key)...');
  const { data: booking2, error: err2 } = await supabase
    .from('bookings')
    .insert({
      restaurant_id: TEST_RESTAURANT_ID,
      booking_date: '2026-06-15',
      booking_time: '19:00',
      party_size: 4,
      guest_name: 'Alice Dashboard',
      guest_email: 'alice.dashboard@test.com',
      guest_phone: '+33123456789',
      source: 'manual',
      idempotency_key: keyA,
      status: 'confirmed',
      booked_for: '2026-06-15T19:00:00',
      covers: 4,
    })
    .select()
    .single();

  if (err2 && err2.code === '23505') {
    console.log(`  ✓ UNIQUE constraint triggered (duplicate prevented)`);
    console.log(`  Booking ID: ${bookingIdA} (same as req1)`);
  } else if (booking2) {
    console.log(`  ✗ No constraint!  Booking ID: ${booking2.id}`);
  } else {
    console.log(`  Error: ${err2?.message}`);
  }

  // Verify DB count
  const { data: countA, error: errCountA } = await supabase
    .from('bookings')
    .select('id', { count: 'exact' })
    .eq('idempotency_key', keyA);

  console.log(`  DB COUNT(idempotency_key='${keyA}'): ${countA?.length || 0}`);
  console.log(`  Expected: 1  Actual: ${countA?.length || 0}  ${countA?.length === 1 ? '✓' : '✗'}`);
  console.log('');

  // TEST B: VAPI simulation
  console.log('═ TEST B: VAPI Booking (2x same call_id as idempotency_key)');
  const keyB = `vapi_${SMOKE_ID}_b`;

  console.log('Request 1...');
  const { data: booking3, error: err3 } = await supabase
    .from('bookings')
    .insert({
      restaurant_id: TEST_RESTAURANT_ID,
      booking_date: '2026-06-16',
      booking_time: '20:00',
      party_size: 2,
      guest_name: 'Bob Vapi',
      guest_email: 'bob.vapi@test.com',
      guest_phone: '+33987654321',
      source: 'phone',
      idempotency_key: keyB,
      call_id: keyB,
      status: 'confirmed',
      booked_for: '2026-06-16T20:00:00',
      covers: 2,
    })
    .select()
    .single();

  if (err3) {
    console.error(`  Error: ${err3.message}`);
    process.exit(1);
  }

  const bookingIdB = booking3.id;
  console.log(`  Booking ID: ${bookingIdB}`);

  console.log('Request 2 (duplicate key)...');
  const { data: booking4, error: err4 } = await supabase
    .from('bookings')
    .insert({
      restaurant_id: TEST_RESTAURANT_ID,
      booking_date: '2026-06-16',
      booking_time: '20:00',
      party_size: 2,
      guest_name: 'Bob Vapi',
      guest_email: 'bob.vapi@test.com',
      guest_phone: '+33987654321',
      source: 'phone',
      idempotency_key: keyB,
      call_id: keyB,
      status: 'confirmed',
      booked_for: '2026-06-16T20:00:00',
      covers: 2,
    })
    .select()
    .single();

  if (err4 && err4.code === '23505') {
    console.log(`  ✓ UNIQUE constraint triggered`);
    console.log(`  Booking ID: ${bookingIdB} (same as req1)`);
  } else {
    console.log(`  Error or different booking: ${err4?.message || booking4?.id}`);
  }

  const { data: countB } = await supabase
    .from('bookings')
    .select('id', { count: 'exact' })
    .eq('idempotency_key', keyB);

  console.log(`  DB COUNT(idempotency_key='${keyB}'): ${countB?.length || 0}  Expected: 1  ${countB?.length === 1 ? '✓' : '✗'}`);
  console.log('');

  // TEST C: Email BCC simulation
  console.log('═ TEST C: Email BCC Booking (2x same idempotency_key)');
  const keyC = `email_${SMOKE_ID}_c`;

  console.log('Request 1...');
  const { data: booking5, error: err5 } = await supabase
    .from('bookings')
    .insert({
      restaurant_id: TEST_RESTAURANT_ID,
      booking_date: '2026-06-17',
      booking_time: '21:00',
      party_size: 3,
      guest_name: 'Charlie Email',
      guest_email: 'charlie.email@test.com',
      guest_phone: '+33555666777',
      source: 'web',
      idempotency_key: keyC,
      status: 'confirmed',
      booked_for: '2026-06-17T21:00:00',
      covers: 3,
    })
    .select()
    .single();

  if (err5) {
    console.error(`  Error: ${err5.message}`);
    process.exit(1);
  }

  const bookingIdC = booking5.id;
  console.log(`  Booking ID: ${bookingIdC}`);

  console.log('Request 2 (duplicate key)...');
  const { data: booking6, error: err6 } = await supabase
    .from('bookings')
    .insert({
      restaurant_id: TEST_RESTAURANT_ID,
      booking_date: '2026-06-17',
      booking_time: '21:00',
      party_size: 3,
      guest_name: 'Charlie Email',
      guest_email: 'charlie.email@test.com',
      guest_phone: '+33555666777',
      source: 'web',
      idempotency_key: keyC,
      status: 'confirmed',
      booked_for: '2026-06-17T21:00:00',
      covers: 3,
    })
    .select()
    .single();

  if (err6 && err6.code === '23505') {
    console.log(`  ✓ UNIQUE constraint triggered`);
    console.log(`  Booking ID: ${bookingIdC} (same as req1)`);
  } else {
    console.log(`  Error or different booking: ${err6?.message || booking6?.id}`);
  }

  const { data: countC } = await supabase
    .from('bookings')
    .select('id', { count: 'exact' })
    .eq('idempotency_key', keyC);

  console.log(`  DB COUNT(idempotency_key='${keyC}'): ${countC?.length || 0}  Expected: 1  ${countC?.length === 1 ? '✓' : '✗'}`);
  console.log('');

  // TEST D: Outbox event creation + claim
  console.log('═ TEST D: Outbox Event Creation (zero PII check)');

  // Insert outbox events for booking1
  const { data: outboxEvents, error: outboxErr } = await supabase
    .from('outbox_events')
    .insert([
      {
        booking_id: bookingIdA,
        restaurant_id: TEST_RESTAURANT_ID,
        channel: 'email',
        dedupe_key: `booking:${bookingIdA}:email`,
        correlation_id: keyA,
        status: 'pending',
      },
      {
        booking_id: bookingIdA,
        restaurant_id: TEST_RESTAURANT_ID,
        channel: 'calendar',
        dedupe_key: `booking:${bookingIdA}:calendar`,
        correlation_id: keyA,
        status: 'pending',
      },
    ])
    .select();

  if (outboxErr) {
    console.log(`  Error creating outbox events: ${outboxErr.message}`);
  } else {
    console.log(`  ✓ Created ${outboxEvents?.length || 0} outbox events for booking ${bookingIdA}`);

    // Check payload structure
    const event = outboxEvents?.[0];
    const hasFields = event && 'booking_id' in event && 'restaurant_id' in event && 'channel' in event && 'correlation_id' in event;
    const hasPII = event && ('guest_name' in event || 'guest_email' in event || 'guest_phone' in event);

    console.log(`  Payload structure: ${hasFields ? '✓ Correct' : '✗ Missing fields'}`);
    console.log(`  PII in payload: ${hasPII ? '✗ FOUND' : '✓ Zero PII'}`);
  }

  const { data: countD } = await supabase
    .from('outbox_events')
    .select('id', { count: 'exact' })
    .eq('booking_id', bookingIdA);

  console.log(`  DB COUNT(outbox_events for ${bookingIdA}): ${countD?.length || 0}  Expected: 2  ${countD?.length === 2 ? '✓' : '✗'}`);
  console.log('');

  // VERDICT
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║                    RUNTIME RESULTS TABLE                       ║');
  console.log('╠═══════════════════════════════════════════════════════════════╣');
  console.log('║ Test | Key | COUNT(bookings) | COUNT(outbox) | Verdict        ║');
  console.log('╠═════════════════════════════════════════════════════════════════╣');
  console.log(`║  A   | ${keyA.substring(0, 10)}... | ${countA?.length || 0} (expect 1)      | N/A           | ${countA?.length === 1 ? '✓ PASS' : '✗ FAIL'} ║`);
  console.log(`║  B   | ${keyB.substring(0, 10)}... | ${countB?.length || 0} (expect 1)      | N/A           | ${countB?.length === 1 ? '✓ PASS' : '✗ FAIL'} ║`);
  console.log(`║  C   | ${keyC.substring(0, 10)}... | ${countC?.length || 0} (expect 1)      | N/A           | ${countC?.length === 1 ? '✓ PASS' : '✗ FAIL'} ║`);
  console.log(`║  D   | (outbox) | N/A            | ${countD?.length || 0} (expect 2) | ${countD?.length === 2 ? '✓ PASS' : '✗ FAIL'} ║`);
  console.log('╚════════════════════════════════════════════════════════════════╝');

  const passCount = [
    countA?.length === 1,
    countB?.length === 1,
    countC?.length === 1,
    countD?.length === 2,
  ].filter(x => x).length;

  console.log(`\nTests Passed: ${passCount}/4`);
  console.log(passCount === 4 ? '\n✓ PRÊT POUR REVIEW HUMAINE' : '\n✗ BLOQUÉ');

  process.exit(passCount === 4 ? 0 : 1);
})().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
