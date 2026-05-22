import supabase from '../config/supabase';
import logger from '../lib/logger';

interface WebhookQueueItem {
  id: string;
  event_type: string;
  payload: Record<string, any>;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  retry_count: number;
  max_retries: number;
  last_error?: string;
  created_at: string;
  processed_at?: string;
}

class WebhookQueueService {
  private maxRetries = 3;

  async enqueue(eventType: string, payload: Record<string, any>): Promise<string | null> {
    try {
      const { data, error } = await supabase
        .from('webhook_queue')
        .insert({
          event_type: eventType,
          payload,
          status: 'pending',
          retry_count: 0,
          max_retries: this.maxRetries,
          created_at: new Date().toISOString(),
        })
        .select('id')
        .single();

      if (error) {
        logger.error({ action: 'enqueue_webhook', error: error.message }, 'Failed to enqueue webhook');
        return null;
      }

      logger.info({ action: 'enqueue_webhook', event_type: eventType, queue_id: data?.id }, 'Webhook enqueued');
      return data?.id || null;
    } catch (err: any) {
      logger.error({ action: 'enqueue_webhook', error: err.message }, 'Exception enqueueing webhook');
      return null;
    }
  }

  async markProcessing(queueId: string): Promise<boolean> {
    try {
      const { error } = await supabase
        .from('webhook_queue')
        .update({ status: 'processing' })
        .eq('id', queueId);

      if (error) {
        logger.error({ action: 'mark_processing', error: error.message }, 'Failed to mark webhook as processing');
        return false;
      }

      return true;
    } catch (err: any) {
      logger.error({ action: 'mark_processing', error: err.message }, 'Exception marking webhook as processing');
      return false;
    }
  }

  async markSuccess(queueId: string): Promise<boolean> {
    try {
      const { error } = await supabase
        .from('webhook_queue')
        .update({ status: 'completed', processed_at: new Date().toISOString() })
        .eq('id', queueId);

      if (error) {
        logger.error({ action: 'mark_success', error: error.message }, 'Failed to mark webhook as completed');
        return false;
      }

      logger.info({ action: 'mark_success', queue_id: queueId }, 'Webhook marked as completed');
      return true;
    } catch (err: any) {
      logger.error({ action: 'mark_success', error: err.message }, 'Exception marking webhook as completed');
      return false;
    }
  }

  async markFailure(queueId: string, error: string): Promise<boolean> {
    try {
      const { data: current } = await supabase
        .from('webhook_queue')
        .select('retry_count, max_retries')
        .eq('id', queueId)
        .single();

      if (!current) {
        return false;
      }

      const newRetryCount = current.retry_count + 1;
      const status = newRetryCount >= current.max_retries ? 'failed' : 'pending';

      const { error: updateError } = await supabase
        .from('webhook_queue')
        .update({
          status,
          retry_count: newRetryCount,
          last_error: error.slice(0, 500),
        })
        .eq('id', queueId);

      if (updateError) {
        logger.error({ action: 'mark_failure', error: updateError.message }, 'Failed to mark webhook as failed');
        return false;
      }

      if (status === 'failed') {
        logger.error(
          { action: 'mark_failure', queue_id: queueId, retry_count: newRetryCount, error },
          'Webhook moved to DLQ (max retries exceeded)'
        );
      } else {
        logger.warn(
          { action: 'mark_failure', queue_id: queueId, retry_count: newRetryCount, error },
          'Webhook will be retried'
        );
      }

      return true;
    } catch (err: any) {
      logger.error({ action: 'mark_failure', error: err.message }, 'Exception marking webhook as failed');
      return false;
    }
  }

  async getPendingCount(): Promise<number> {
    try {
      const { count, error } = await supabase
        .from('webhook_queue')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending');

      if (error) {
        logger.error({ action: 'get_pending_count', error: error.message }, 'Failed to get pending webhook count');
        return 0;
      }

      return count || 0;
    } catch (err: any) {
      logger.error({ action: 'get_pending_count', error: err.message }, 'Exception getting pending webhook count');
      return 0;
    }
  }

  async getFailedCount(): Promise<number> {
    try {
      const { count, error } = await supabase
        .from('webhook_queue')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'failed');

      if (error) {
        logger.error({ action: 'get_failed_count', error: error.message }, 'Failed to get failed webhook count');
        return 0;
      }

      return count || 0;
    } catch (err: any) {
      logger.error({ action: 'get_failed_count', error: err.message }, 'Exception getting failed webhook count');
      return 0;
    }
  }
}

export default new WebhookQueueService();
