import supabase from '../config/supabase';
import logger from '../lib/logger';

class CallLoggingService {
  async logCallStarted(event: any): Promise<void> {
    try {
      const callId = event.message?.call?.id || event.callId;
      const phoneNumber = event.message?.call?.from;
      const restaurantId = event.restaurantId;

      if (!callId || !phoneNumber) {
        logger.warn({ action: 'log_call_started' }, 'Missing callId or phoneNumber');
        return;
      }

      await supabase
        .from('call_logs')
        .insert({
          external_call_id: callId,
          caller_number: phoneNumber,
          restaurant_id: restaurantId,
          started_at: new Date().toISOString(),
          status: 'in_progress',
        })
        .select('id')
        .single();

      logger.info(
        { action: 'log_call_started', call_id: callId, phone: phoneNumber },
        'Call started logged'
      );
    } catch (err: any) {
      logger.error(
        { action: 'log_call_started', error: err.message },
        'Failed to log call started'
      );
    }
  }

  async logCallEnded(event: any): Promise<void> {
    try {
      const callId = event.message?.call?.id || event.callId;
      const duration = event.message?.call?.duration || event.duration || 0;
      const statusCode = event.message?.call?.statusCode;
      const transcripts = event.message?.messages;

      if (!callId) {
        logger.warn({ action: 'log_call_ended' }, 'Missing callId');
        return;
      }

      const callLogData: any = {
        status: statusCode ? 'completed' : 'failed',
        ended_at: new Date().toISOString(),
        duration: Math.round(duration),
      };

      if (transcripts && Array.isArray(transcripts)) {
        callLogData.transcript = transcripts
          .map((m: any) => `${m.role}: ${m.message}`)
          .join('\n');
      }

      await supabase
        .from('call_logs')
        .update(callLogData)
        .eq('external_call_id', callId);

      logger.info(
        { action: 'log_call_ended', call_id: callId, duration },
        'Call ended logged'
      );
    } catch (err: any) {
      logger.error(
        { action: 'log_call_ended', error: err.message },
        'Failed to log call ended'
      );
    }
  }

  async updateCallWithBooking(callId: string, bookingId: string): Promise<void> {
    try {
      await supabase
        .from('call_logs')
        .update({ booking_id: bookingId })
        .eq('external_call_id', callId);

      logger.info(
        { action: 'update_call_booking', call_id: callId, booking_id: bookingId },
        'Call linked to booking'
      );
    } catch (err: any) {
      logger.error(
        { action: 'update_call_booking', error: err.message },
        'Failed to link call to booking'
      );
    }
  }
}

export default new CallLoggingService();
