import crypto from 'crypto';
import { Request } from 'express';

// Mock the signature verification function (same logic as in vapi.ts)
function verifyVapiSignature(req: Request, secret: string): boolean {
  const signature = req.headers['x-vapi-signature'] as string;
  const timestamp = req.headers['x-vapi-timestamp'] as string;
  const nonce = req.headers['x-vapi-nonce'] as string;

  if (!signature || !timestamp || !nonce) {
    return false;
  }

  const message = `${timestamp}.${nonce}.${JSON.stringify(req.body)}`;
  const computedSignature = crypto
    .createHmac('sha256', secret)
    .update(message)
    .digest('hex');

  if (signature.length !== computedSignature.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(computedSignature)
  );
}

describe('VAPI Webhook Security', () => {
  const secret = 'test-webhook-secret';
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload = { event: 'call.ended', callId: 'test-123' };

  it('should accept valid signature', () => {
    const message = `${timestamp}.${nonce}.${JSON.stringify(payload)}`;
    const validSignature = crypto
      .createHmac('sha256', secret)
      .update(message)
      .digest('hex');

    const mockReq = {
      headers: {
        'x-vapi-signature': validSignature,
        'x-vapi-timestamp': timestamp,
        'x-vapi-nonce': nonce,
      },
      body: payload,
    } as unknown as Request;

    expect(verifyVapiSignature(mockReq, secret)).toBe(true);
  });

  it('should reject invalid signature', () => {
    const invalidSignature = 'invalid-signature-12345';

    const mockReq = {
      headers: {
        'x-vapi-signature': invalidSignature,
        'x-vapi-timestamp': timestamp,
        'x-vapi-nonce': nonce,
      },
      body: payload,
    } as unknown as Request;

    expect(verifyVapiSignature(mockReq, secret)).toBe(false);
  });

  it('should reject missing signature header', () => {
    const mockReq = {
      headers: {
        'x-vapi-timestamp': timestamp,
        'x-vapi-nonce': nonce,
      },
      body: payload,
    } as unknown as Request;

    expect(verifyVapiSignature(mockReq, secret)).toBe(false);
  });

  it('should reject missing timestamp header', () => {
    const message = `${timestamp}.${nonce}.${JSON.stringify(payload)}`;
    const signature = crypto
      .createHmac('sha256', secret)
      .update(message)
      .digest('hex');

    const mockReq = {
      headers: {
        'x-vapi-signature': signature,
        'x-vapi-nonce': nonce,
      },
      body: payload,
    } as unknown as Request;

    expect(verifyVapiSignature(mockReq, secret)).toBe(false);
  });

  it('should reject missing nonce header', () => {
    const message = `${timestamp}.${nonce}.${JSON.stringify(payload)}`;
    const signature = crypto
      .createHmac('sha256', secret)
      .update(message)
      .digest('hex');

    const mockReq = {
      headers: {
        'x-vapi-signature': signature,
        'x-vapi-timestamp': timestamp,
      },
      body: payload,
    } as unknown as Request;

    expect(verifyVapiSignature(mockReq, secret)).toBe(false);
  });

  it('should reject signature with wrong body', () => {
    const message = `${timestamp}.${nonce}.${JSON.stringify(payload)}`;
    const signature = crypto
      .createHmac('sha256', secret)
      .update(message)
      .digest('hex');

    const differentPayload = { event: 'call.started', callId: 'different-123' };

    const mockReq = {
      headers: {
        'x-vapi-signature': signature,
        'x-vapi-timestamp': timestamp,
        'x-vapi-nonce': nonce,
      },
      body: differentPayload,
    } as unknown as Request;

    expect(verifyVapiSignature(mockReq, secret)).toBe(false);
  });

  it('should reject signature with wrong timestamp', () => {
    const message = `${timestamp}.${nonce}.${JSON.stringify(payload)}`;
    const signature = crypto
      .createHmac('sha256', secret)
      .update(message)
      .digest('hex');

    const wrongTimestamp = (Math.floor(Date.now() / 1000) - 3600).toString();

    const mockReq = {
      headers: {
        'x-vapi-signature': signature,
        'x-vapi-timestamp': wrongTimestamp,
        'x-vapi-nonce': nonce,
      },
      body: payload,
    } as unknown as Request;

    expect(verifyVapiSignature(mockReq, secret)).toBe(false);
  });
});
