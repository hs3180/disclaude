/**
 * Tests for Ruliu Webhook Handler.
 *
 * Tests incoming webhook message processing, signature verification,
 * message decryption, and URL verification.
 *
 * Related: #1617 Phase 4
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RuliuWebhookHandler } from './ruliu-webhook-handler.js';
import type { RuliuConfig, RuliuMessageEvent } from './types.js';

// Mock @disclaude/core
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

// Mock ruliu-crypto
vi.mock('./ruliu-crypto.js', () => ({
  decryptMessage: vi.fn().mockReturnValue('{"content":"Hello","fromUsername":"user1","msgType":"text","chatId":"chat1","groupId":"100","msgId":"msg1","createTime":1234567890}'),
  verifySignature: vi.fn().mockReturnValue(true),
}));

import { decryptMessage, verifySignature } from './ruliu-crypto.js';

const mockConfig: RuliuConfig = {
  apiHost: 'https://apiin.im.baidu.com',
  checkToken: 'test-check-token',
  encodingAESKey: 'test-aes-key',
  appKey: 'test-app-key',
  appSecret: 'test-app-secret',
  robotName: 'TestBot',
};

const mockDecryptedContent = {
  content: '@TestBot Hello there',
  fromUsername: 'user_123',
  msgType: 'text',
  chatId: 'chat_abc',
  groupId: '100',
  msgId: 'msg_xyz',
  createTime: 1234567890,
};

describe('RuliuWebhookHandler', () => {
  let handler: RuliuWebhookHandler;
  let mockOnMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockOnMessage = vi.fn().mockResolvedValue(undefined);
    handler = new RuliuWebhookHandler({
      config: { ...mockConfig },
      callbacks: { onMessage: mockOnMessage },
    });
    (decryptMessage as ReturnType<typeof vi.fn>).mockReturnValue(JSON.stringify(mockDecryptedContent));
    (verifySignature as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  describe('handleWebhook', () => {
    it('should process valid text message and return success', async () => {
      const body = { encrypt: 'encrypted_data', signature: 'sig', timestamp: '1234', nonce: 'nonce' };
      const query = { signature: 'sig', timestamp: '1234', nonce: 'nonce' };

      const result = await handler.handleWebhook(body, query);

      expect(result.status).toBe(200);
      expect(result.body).toBe('success');
      expect(mockOnMessage).toHaveBeenCalledTimes(1);
    });

    it('should parse string body', async () => {
      const body = JSON.stringify({ encrypt: 'encrypted_data', signature: 'sig', timestamp: '1234', nonce: 'nonce' });
      const query = { signature: 'sig', timestamp: '1234', nonce: 'nonce' };

      const result = await handler.handleWebhook(body, query);

      expect(result.status).toBe(200);
      expect(mockOnMessage).toHaveBeenCalledTimes(1);
    });

    it('should return 401 when signature is invalid', async () => {
      (verifySignature as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const body = { encrypt: 'encrypted_data', signature: 'sig', timestamp: '1234', nonce: 'nonce' };
      const query = { signature: 'sig', timestamp: '1234', nonce: 'nonce' };

      const result = await handler.handleWebhook(body, query);

      expect(result.status).toBe(401);
      expect(result.body).toBe('Invalid signature');
      expect(mockOnMessage).not.toHaveBeenCalled();
    });

    it('should skip signature verification when query params are missing', async () => {
      const body = { encrypt: 'encrypted_data', signature: 'sig', timestamp: '1234', nonce: 'nonce' };
      const query = {};

      const result = await handler.handleWebhook(body, query);

      expect(result.status).toBe(200);
      expect(verifySignature).not.toHaveBeenCalled();
    });

    it('should skip signature verification when only some query params are present', async () => {
      const body = { encrypt: 'encrypted_data' };
      const query = { signature: 'sig' };

      const result = await handler.handleWebhook(body as any, query);

      expect(result.status).toBe(200);
      expect(verifySignature).not.toHaveBeenCalled();
    });

    it('should return 500 when decryption fails', async () => {
      (decryptMessage as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('Decryption failed');
      });

      const body = { encrypt: 'bad_data' } as any;
      const query = {};

      const result = await handler.handleWebhook(body, query);

      expect(result.status).toBe(500);
      expect(result.body).toBe('Internal error');
      expect(mockOnMessage).not.toHaveBeenCalled();
    });

    it('should return 500 when decrypted content is invalid JSON', async () => {
      (decryptMessage as ReturnType<typeof vi.fn>).mockReturnValue('not json');

      const body = { encrypt: 'data' } as any;
      const query = {};

      const result = await handler.handleWebhook(body, query);

      expect(result.status).toBe(500);
    });

    it('should detect @mention in message content', async () => {
      await handler.handleWebhook(
        { encrypt: 'data' } as any,
        {}
      );

      expect(mockOnMessage).toHaveBeenCalledTimes(1);
      const event = mockOnMessage.mock.calls[0][0] as RuliuMessageEvent;
      expect(event.wasMentioned).toBe(true);
    });

    it('should not detect mention when robot name is not in content', async () => {
      const noMentionContent = { ...mockDecryptedContent, content: 'Hello there' };
      (decryptMessage as ReturnType<typeof vi.fn>).mockReturnValue(JSON.stringify(noMentionContent));

      await handler.handleWebhook({ encrypt: 'data' } as any, {});

      const event = mockOnMessage.mock.calls[0][0] as RuliuMessageEvent;
      expect(event.wasMentioned).toBe(false);
    });

    it('should skip non-text non-markdown messages', async () => {
      const imageContent = { ...mockDecryptedContent, msgType: 'image' };
      (decryptMessage as ReturnType<typeof vi.fn>).mockReturnValue(JSON.stringify(imageContent));

      const result = await handler.handleWebhook({ encrypt: 'data' } as any, {});

      expect(result.status).toBe(200);
      expect(mockOnMessage).not.toHaveBeenCalled();
    });

    it('should process markdown messages', async () => {
      const mdContent = { ...mockDecryptedContent, msgType: 'markdown' };
      (decryptMessage as ReturnType<typeof vi.fn>).mockReturnValue(JSON.stringify(mdContent));

      const result = await handler.handleWebhook({ encrypt: 'data' } as any, {});

      expect(result.status).toBe(200);
      expect(mockOnMessage).toHaveBeenCalledTimes(1);
    });

    it('should set chatType to group when groupId is present', async () => {
      await handler.handleWebhook({ encrypt: 'data' } as any, {});

      const event = mockOnMessage.mock.calls[0][0] as RuliuMessageEvent;
      expect(event.chatType).toBe('group');
    });

    it('should set chatType to direct when groupId is absent', async () => {
      const directContent = { ...mockDecryptedContent, groupId: undefined };
      (decryptMessage as ReturnType<typeof vi.fn>).mockReturnValue(JSON.stringify(directContent));

      await handler.handleWebhook({ encrypt: 'data' } as any, {});

      const event = mockOnMessage.mock.calls[0][0] as RuliuMessageEvent;
      expect(event.chatType).toBe('direct');
      expect(event.groupId).toBeUndefined();
    });

    it('should parse groupId as number when present', async () => {
      await handler.handleWebhook({ encrypt: 'data' } as any, {});

      const event = mockOnMessage.mock.calls[0][0] as RuliuMessageEvent;
      expect(event.groupId).toBe(100);
    });

    it('should build correct message event structure', async () => {
      await handler.handleWebhook({ encrypt: 'data' } as any, {});

      const event = mockOnMessage.mock.calls[0][0] as RuliuMessageEvent;
      expect(event.fromuser).toBe('user_123');
      expect(event.mes).toBe('@TestBot Hello there');
      expect(event.messageId).toBe('msg_xyz');
      expect(event.timestamp).toBe(1234567890);
    });
  });

  describe('handleUrlVerification', () => {
    it('should return decrypted challenge on success', () => {
      const decryptedChallenge = 'challenge_token_12345';
      (decryptMessage as ReturnType<typeof vi.fn>).mockReturnValue(decryptedChallenge);

      const body = { encrypt: 'encrypted_challenge' } as any;
      const query = { signature: 'sig', timestamp: '1234', nonce: 'nonce' };

      const result = handler.handleUrlVerification(body, query);

      expect(result.status).toBe(200);
      expect(result.body).toBe(decryptedChallenge);
    });

    it('should parse string body for URL verification', () => {
      (decryptMessage as ReturnType<typeof vi.fn>).mockReturnValue('challenge');

      const body = JSON.stringify({ encrypt: 'encrypted_challenge' });
      const query = {};

      const result = handler.handleUrlVerification(body, query);

      expect(result.status).toBe(200);
      expect(result.body).toBe('challenge');
    });

    it('should return 401 when signature verification fails', () => {
      (verifySignature as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const body = { encrypt: 'encrypted_challenge' } as any;
      const query = { signature: 'bad_sig', timestamp: '1234', nonce: 'nonce' };

      const result = handler.handleUrlVerification(body, query);

      expect(result.status).toBe(401);
      expect(result.body).toBe('Invalid signature');
    });

    it('should return 500 when decryption fails', () => {
      (decryptMessage as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('Decryption error');
      });

      const body = { encrypt: 'bad_data' } as any;
      const query = {};

      const result = handler.handleUrlVerification(body, query);

      expect(result.status).toBe(500);
      expect(result.body).toBe('Internal error');
    });

    it('should skip signature check when query params incomplete', () => {
      (decryptMessage as ReturnType<typeof vi.fn>).mockReturnValue('challenge');

      const body = { encrypt: 'encrypted_challenge' } as any;
      const query = { signature: 'sig' };

      const result = handler.handleUrlVerification(body, query);

      expect(result.status).toBe(200);
      expect(verifySignature).not.toHaveBeenCalled();
    });
  });
});
