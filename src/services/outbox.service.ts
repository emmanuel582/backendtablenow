import supabase from '../config/supabase';
import logger from '../lib/logger';
import { DatabaseError } from '../lib/errors';

// Outbox pattern: minimal payload (booking_id, channel only)
// NO PII in payload (email/calendar details fetched by worker at processing time)

export interface OutboxEvent {
  id: string;
  booking_id: string;
  restaurant_id: string;
  channel: 'email' | 'calendar';
  dedupe_key: string;
  status: 'pending' | 'claimed' | 'done' | 'failed';
  attempts: number;
  correlation_id?: string;
  created_at: string;
}

// Create outbox events (after booking insert)
export async function createOutboxEvents(
  bookingId: string,
  restaurantId: string,
  correlationId: string,
  channels: ('email' | 'calendar')[]
) {
  const events = channels.map(ch => ({
    booking_id: bookingId,
    restaurant_id: restaurantId,
    channel: ch,
    dedupe_key: `booking:${bookingId}:${ch}`,
    correlation_id: correlationId,
    status: 'pending' as const,
  }));

  const { error } = await supabase
    .from('outbox_events')
    .insert(events);

  if (error) {
    logger.error({ error, bookingId }, 'Failed to create outbox events');
    throw new DatabaseError('Outbox event creation failed', error);
  }
}

// Claim next batch (concurrency-safe: UPDATE + check timestamp)
export async function claimPendingEvents(limit = 10) {
  const now = new Date();

  // Fetch pending events that are ready (next_attempt_at is null or past)
  const { data: events, error } = await supabase
    .from('outbox_events')
    .select('*')
    .eq('status', 'pending')
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${now.toISOString()}`)
    .limit(limit);

  if (error) {
    logger.error({ error }, 'Failed to fetch pending outbox events');
    return [];
  }

  if (!events || events.length === 0) return [];

  // Mark as claimed atomically
  const eventIds = events.map(e => e.id);
  const { error: claimError } = await supabase
    .from('outbox_events')
    .update({ status: 'claimed' })
    .in('id', eventIds);

  if (claimError) {
    logger.warn({ claimError }, 'Failed to claim outbox events (will retry next batch)');
    return [];
  }

  return events as OutboxEvent[];
}

// Mark as done
export async function markDone(eventId: string) {
  const { error } = await supabase
    .from('outbox_events')
    .update({ status: 'done' })
    .eq('id', eventId);

  if (error) {
    logger.error({ error, eventId }, 'Failed to mark outbox event done');
    throw new DatabaseError('Update failed', error);
  }
}

// Mark as failed + schedule retry or DLQ
export async function markFailed(eventId: string, error: string) {
  const { data: event } = await supabase
    .from('outbox_events')
    .select('attempts, max_attempts')
    .eq('id', eventId)
    .single();

  const attempts = (event?.attempts || 0) + 1;
  const maxAttempts = event?.max_attempts || 3;
  const isFailed = attempts >= maxAttempts;

  const backoffMs = Math.pow(2, attempts - 1) * 5000; // 5s, 10s, 20s, ...
  const nextAttempt = isFailed
    ? null
    : new Date(Date.now() + backoffMs).toISOString();

  const { error: updateError } = await supabase
    .from('outbox_events')
    .update({
      status: isFailed ? 'failed' : 'pending',
      attempts,
      last_error: error,
      next_attempt_at: nextAttempt,
    })
    .eq('id', eventId);

  if (updateError) {
    logger.error({ updateError, eventId }, 'Failed to update outbox event status');
    throw new DatabaseError('Status update failed', updateError);
  }

  if (isFailed) {
    logger.error({ eventId, attempts, error }, 'Outbox event moved to DLQ');
  }
}

// Get event details (for processing)
export async function getEvent(eventId: string) {
  const { data } = await supabase
    .from('outbox_events')
    .select('*')
    .eq('id', eventId)
    .single();

  return data as OutboxEvent | null;
}

export default {
  createOutboxEvents,
  claimPendingEvents,
  markDone,
  markFailed,
  getEvent,
};
