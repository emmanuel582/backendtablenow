import crypto from 'crypto';

const ALGO   = 'aes-256-gcm';
const PREFIX = 'enc:';

function getKey(): Buffer | null {
    const keyHex = process.env.CALENDAR_ENCRYPTION_KEY;
    if (!keyHex || keyHex.length !== 64) return null;
    return Buffer.from(keyHex, 'hex');
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * Returns the plaintext unchanged if CALENDAR_ENCRYPTION_KEY is not set.
 */
export function encrypt(text: string): string {
    const key = getKey();
    if (!key) return text;

    const iv        = crypto.randomBytes(12);
    const cipher    = crypto.createCipheriv(ALGO, key, iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const tag       = cipher.getAuthTag();

    return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt a value produced by encrypt().
 * Returns the value unchanged if it is not prefixed (backward-compat with unencrypted rows).
 */
export function decrypt(text: string): string {
    if (!text || !text.startsWith(PREFIX)) return text;

    const key = getKey();
    if (!key) {
        console.warn('[crypto] CALENDAR_ENCRYPTION_KEY not set — cannot decrypt, returning raw value');
        return text;
    }

    const parts = text.slice(PREFIX.length).split(':');
    if (parts.length !== 3) return text;

    const [ivHex, tagHex, encHex] = parts;
    const iv        = Buffer.from(ivHex,  'hex');
    const tag       = Buffer.from(tagHex, 'hex');
    const encrypted = Buffer.from(encHex, 'hex');

    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted).toString('utf8') + decipher.final('utf8');
}
