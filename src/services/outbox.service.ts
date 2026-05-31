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
  attempts: number;
  max_attempts: number;
  correlation_id?: string;
}

// NOTE: Outbox events are NO LONGER created here via a separate insert.
// They are created atomically inside the Postgres function
// create_booking_with_outbox() (booking + outbox in ONE transaction).
// See migrations/001_booking_idempotency_outbox.sql.

// Claim next batch (concurrency-safe: atomic via Postgres FOR UPDATE SKIP LOCKED)
export async function claimPendingEvents(limit = 10, workerId?: string) {
  // Atomic Postgres function claim_outbox_events():
  //   - claims 'pending' events that are ready (next_attempt_at past/null)
  //   - recovers 'claimed' events whose lease expired (crashed worker)
  //   - increments attempts, sets claimed_at / claimed_by
  //   - FOR UPDATE SKIP LOCKED ⇒ two workers never claim the same row
  const { data: events, error } = await supabase.rpc('claim_outbox_events', {
    p_batch_size: limit,
    p_worker_id: workerId ?? null,
    p_lease_seconds: 300,
  });

  if (error) {
    logger.error({ error }, 'Failed to claim pending outbox events via RPC');
    return [];
  }

  if (!events || events.length === 0) return [];

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
  claimPendingEvents,
  markDone,
  markFailed,
  getEvent,
};
