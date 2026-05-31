import supabase from '../config/supabase';
import logger from '../lib/logger';
import emailService from '../services/email.service';
import calendarService from '../services/calendar.service';
import outboxService from '../services/outbox.service';

// Worker: process claimed outbox events
// Concurrency-safe: each worker claims events atomically, prevents double-processing

export async function processOutboxWorker() {
  const log = logger.child({ worker: 'outbox' });

  try {
    const events = await outboxService.claimPendingEvents(10);
    if (!events || events.length === 0) {
      log.debug('No pending outbox events');
      return { processed: 0, failed: 0 };
    }

    log.info({ count: events.length }, 'Processing outbox events');

    let processed = 0;
    let failed = 0;

    for (const event of events) {
      try {
        await processEvent(event, log);
        await outboxService.markDone(event.id);
        processed++;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'unknown';
        await outboxService.markFailed(event.id, errMsg);
        failed++;
      }
    }

    log.info({ processed, failed }, 'Outbox worker completed');
    return { processed, failed };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'unknown';
    log.error({ error: errMsg }, 'Outbox worker fatal error');
    throw err;
  }
}

async function processEvent(event: any, log: any) {
  const { id, booking_id, restaurant_id, channel, correlation_id } = event;

  // Fetch booking details (minimal: email/phone/date/time only)
  const { data: booking, error: bErr } = await supabase
    .from('bookings')
    .select('id, booking_date, booking_time, guest_email, guest_phone, guest_name, party_size, restaurant_id')
    .eq('id', booking_id)
    .single();

  if (bErr || !booking) {
    throw new Error(`Booking not found: ${booking_id}`);
  }

  // Fetch restaurant details
  const { data: restaurant, error: rErr } = await supabase
    .from('restaurants')
    .select('id, name, address, phone, google_calendar_tokens')
    .eq('id', restaurant_id)
    .single();

  if (rErr || !restaurant) {
    throw new Error(`Restaurant not found: ${restaurant_id}`);
  }

  const childLog = log.child({ eventId: id, bookingId: booking_id, channel, correlationId: correlation_id });

  if (channel === 'email') {
    if (!booking.guest_email) {
      childLog.debug('Skipping email: no guest email');
      return;
    }

    childLog.debug('Sending confirmation email');
    await emailService.sendBookingConfirmation({
      to: booking.guest_email,
      restaurantName: restaurant.name,
      restaurantAddress: restaurant.address || '',
      restaurantPhone: restaurant.phone || '',
      guestName: booking.guest_name,
      date: booking.booking_date,
      time: booking.booking_time,
      partySize: booking.party_size,
      confirmationNumber: booking.id,
      language: 'fr', // Default; ideally stored in bookings
    });

    childLog.debug('Email sent');
  } else if (channel === 'calendar') {
    if (!restaurant.google_calendar_tokens) {
      childLog.debug('Skipping calendar: no tokens');
      return;
    }

    childLog.debug('Creating calendar event');
    const tokens = JSON.parse(restaurant.google_calendar_tokens);
    const start = new Date(`${booking.booking_date}T${booking.booking_time}`);
    const end = new Date(start.getTime() + 2 * 3600000);

    await calendarService.createEvent(tokens, {
      summary: `${booking.guest_name} (${booking.party_size} pers.)`,
      description: '', // NO PII
      start,
      end,
      attendees: booking.guest_email ? [booking.guest_email] : [],
    });

    childLog.debug('Calendar event created');
  }
}

export default { processOutboxWorker };
