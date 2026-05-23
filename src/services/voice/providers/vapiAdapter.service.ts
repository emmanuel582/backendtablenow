// ============================================
// VAPI Adapter — Voice Provider Layer
//
// Sole purpose: translate VAPI-specific shapes ↔ TableNow internal
// VoiceProviderPayload / VAPI tool response.
//
// No business logic should live here. No DB calls.
// ============================================

import type { Request } from 'express';
import logger from '../../../lib/logger';
import type {
  VoiceProviderEventType,
  VoiceProviderPayload,
  VoiceToolCall,
} from '../../../types/voice.types';

interface VapiBody {
  message?: Record<string, unknown>;
  type?: string;
  call?: Record<string, unknown>;
  [k: string]: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

class VapiAdapterService {
  mapEventType(rawType: string | undefined | null): VoiceProviderEventType {
    switch (rawType) {
      case 'call.started':
        return 'call.started';
      case 'call.ended':
        return 'call.ended';
      case 'tool-calls':
      case 'function-call':
        return 'tool.invoked';
      case 'assistant-request':
      case 'message':
        return 'message';
      case 'end-of-call-report':
        return 'end_of_call_report';
      default:
        return 'unknown';
    }
  }

  extractToolCall(message: Record<string, unknown>): VoiceToolCall | null {
    const toolCallList = Array.isArray(message['toolCallList'])
      ? (message['toolCallList'] as unknown[])
      : null;
    const toolCalls = Array.isArray(message['toolCalls'])
      ? (message['toolCalls'] as unknown[])
      : null;

    const candidate = (toolCallList?.[0] ?? toolCalls?.[0]) as
      | Record<string, unknown>
      | undefined;

    if (!candidate) return null;

    const fn = asRecord(candidate['function']);
    const rawArgs =
      fn['arguments'] ?? candidate['parameters'] ?? candidate['arguments'];

    let parameters: Record<string, unknown> = {};
    if (typeof rawArgs === 'string') {
      try {
        const parsed = JSON.parse(rawArgs) as unknown;
        parameters = asRecord(parsed);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        logger.warn(
          { action: 'vapi_adapter_parse_args', error: msg },
          'Failed to parse tool-call arguments JSON'
        );
      }
    } else {
      parameters = asRecord(rawArgs);
    }

    const id =
      asString(candidate['id']) ??
      asString(candidate['toolCallId']) ??
      'unknown';
    const name = asString(fn['name']) ?? asString(candidate['name']) ?? 'unknown';

    return {
      tool_call_id: id,
      name,
      parameters,
    };
  }

  toInternalPayload(req: Request): VoiceProviderPayload {
    const body = (req.body ?? {}) as VapiBody;
    const message = asRecord(body.message ?? body);

    const call = asRecord(message['call']);
    const rawType = asString(message['type'] ?? body['type']);
    const transcript = asString(message['transcript']);
    const tool_call = this.extractToolCall(message);

    return {
      call_id: asString(call['id']) ?? 'unknown',
      caller_phone: asString(call['from']),
      called_phone: asString(call['to']),
      event_type: this.mapEventType(rawType),
      transcript,
      tool_call,
      raw: message,
    };
  }

  // Build a VAPI tool response — used by check-availability/create-reservation
  buildToolResponse(
    tool_call_id: string,
    result: Record<string, unknown>
  ): Record<string, unknown> {
    return {
      results: [
        {
          toolCallId: tool_call_id,
          result: JSON.stringify(result),
        },
      ],
    };
  }
}

export default new VapiAdapterService();
