/**
 * Remove empty text blocks from a messages array before sending to an LLM API.
 * Prevents "text content blocks must be non-empty" (Anthropic 400) when a message
 * is built from dynamic fields that may be undefined/empty.
 */
export function sanitizeMessages(messages: any[]): any[] {
    return messages
        .map((msg) => {
            if (typeof msg.content === 'string') {
                return { ...msg, content: msg.content.trim() };
            }
            if (Array.isArray(msg.content)) {
                const filtered = msg.content.filter((block: any) => {
                    if (block.type !== 'text') return true;
                    return typeof block.text === 'string' && block.text.trim().length > 0;
                });
                return { ...msg, content: filtered };
            }
            return msg;
        })
        .filter((msg) => {
            if (typeof msg.content === 'string') return msg.content.length > 0;
            if (Array.isArray(msg.content))      return msg.content.length > 0;
            return true;
        });
}

/**
 * Ensure a system prompt string is never empty before sending to an LLM.
 * Falls back to a safe placeholder so the API call doesn't 400.
 */
export function sanitizePrompt(prompt: string | undefined | null, fallback = 'You are a helpful assistant.'): string {
    const trimmed = (prompt ?? '').trim();
    return trimmed.length > 0 ? trimmed : fallback;
}
