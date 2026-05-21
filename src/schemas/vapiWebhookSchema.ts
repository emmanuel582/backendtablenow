/**
 * VAPI Webhook Validation Schema
 * Validates POST /api/vapi/webhook payloads
 */

import { z } from 'zod';

export const VapiToolCallSchema = z.object({
    id: z.string().optional(),
    type: z.literal('function').optional(),
    function: z.object({
        name: z.string(),
        arguments: z.union([z.string(), z.record(z.unknown())])
    }).optional(),
    // Legacy format support
    name: z.string().optional(),
    parameters: z.record(z.unknown()).optional()
});

export const VapiMessageSchema = z.object({
    role: z.enum(['assistant', 'user']),
    message: z.string(),
    timestamp: z.string().optional()
});

export const VapiCallDataSchema = z.object({
    id: z.string(),
    assistant: z.object({
        id: z.string(),
        name: z.string()
    }).optional(),
    customer: z.object({
        number: z.string().optional()
    }).optional(),
    started_at: z.string().optional(),
    ended_at: z.string().optional(),
    duration: z.number().optional(),
    status: z.enum(['active', 'ended', 'failed']).optional(),
    messages: z.array(VapiMessageSchema).optional(),
    tool_calls: z.array(VapiToolCallSchema).optional()
});

export const VapiWebhookPayloadSchema = z.object({
    event: z.enum(['call-started', 'call-ended', 'booking-requested', 'message-sent']),
    call: VapiCallDataSchema.optional(),
    message: z.object({
        id: z.string(),
        call_id: z.string(),
        type: z.enum(['sms', 'whatsapp']),
        from: z.string().optional(),
        to: z.string().optional(),
        content: z.string(),
        timestamp: z.string().optional()
    }).optional()
}).strict(); // Reject unknown fields

export type VapiWebhookPayload = z.infer<typeof VapiWebhookPayloadSchema>;
export type VapiToolCall = z.infer<typeof VapiToolCallSchema>;
