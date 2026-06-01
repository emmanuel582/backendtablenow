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

// Schéma permissif : VAPI envoie des payloads variés ({ message: { type: 'end-of-call-report'|'status-update'|'tool-calls'|... } })
// avec de nombreux champs. Le handler /webhook extrait défensivement ce dont il a besoin
// (req.body.message || req.body). On valide juste que c'est un objet et on laisse passer le reste.
export const VapiWebhookPayloadSchema = z.object({
    message: z.unknown().optional(),
    call: z.unknown().optional(),
    type: z.string().optional(),
    event: z.string().optional(),
}).passthrough();

export type VapiWebhookPayload = z.infer<typeof VapiWebhookPayloadSchema>;
export type VapiToolCall = z.infer<typeof VapiToolCallSchema>;
