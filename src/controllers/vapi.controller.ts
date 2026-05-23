// ============================================
// VAPI Controller — Voice Core orchestrator
//
// Thin layer that wires the VAPI route surface to the Voice Core services.
//
// Flow per inbound webhook:
//   request → vapiAdapter (translate)
//          → phoneResolution (find restaurant)
//          → assistantConfig (build context)
//          → conversationReliability (decide next action)
//          → bookingOrchestration (only if reliability green-lights)
//          → callLogging (structured trail)
// ============================================

import type { Request, Response } from 'express';
import logger from '../lib/logger';
import vapiAdapter from '../services/voice/providers/vapiAdapter.service';
import phoneResolution from '../services/voice/phoneResolution.service';
import assistantConfig from '../services/voice/assistantConfig.service';
import callLogging from '../services/voice/callLogging.service';
import type {
  VoiceProviderPayload,
} from '../types/voice.types';

class VapiController {
  async handleAssistantConfig(req: Request, res: Response): Promise<void> {
    let payload: VoiceProviderPayload;
    try {
      payload = vapiAdapter.toInternalPayload(req);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      logger.error(
        { action: 'assistant_config_adapter', error: msg },
        'Failed to translate VAPI payload'
      );
      res.status(400).json({ error: 'Invalid payload' });
      return;
    }

    const calledPhone = payload.called_phone;
    if (!calledPhone) {
      res.status(400).json({ error: 'No phone number in request' });
      return;
    }

    const restaurant = await phoneResolution.resolveByPhone(calledPhone);
    if (!restaurant) {
      logger.error(
        { action: 'assistant_config', called_phone: calledPhone },
        'Restaurant not found for inbound phone'
      );
      res.status(404).json({ error: 'Restaurant not found' });
      return;
    }

    const context = assistantConfig.buildAssistantContext(restaurant);

    callLogging.emitTyped(payload.call_id, restaurant.id, 'intent_detected', {
      stage: 'assistant_config',
    });

    res.json({
      assistant: {
        variableValues: context.variables,
      },
    });
  }

  async handleCallStarted(req: Request): Promise<void> {
    const payload = vapiAdapter.toInternalPayload(req);
    const restaurant = payload.called_phone
      ? await phoneResolution.resolveByPhone(payload.called_phone)
      : null;

    await callLogging.logCallStarted({
      call_id: payload.call_id,
      caller_phone: payload.caller_phone,
      restaurant_id: restaurant?.id ?? null,
    });
  }

  async handleCallEnded(req: Request): Promise<void> {
    const payload = vapiAdapter.toInternalPayload(req);
    const raw = payload.raw;
    const call = (raw['call'] ?? {}) as Record<string, unknown>;
    const duration =
      typeof call['duration'] === 'number' ? (call['duration'] as number) : 0;
    const statusCode = call['statusCode'];

    await callLogging.logCallEnded({
      call_id: payload.call_id,
      duration_seconds: duration,
      transcript: payload.transcript,
      status: statusCode ? 'completed' : 'failed',
    });
  }
}

export default new VapiController();
