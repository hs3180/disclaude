/**
 * Tests for Ruliu Webhook Handler.
 *
 * @see ruliu-webhook-handler.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RuliuWebhookHandler } from './ruliu-webhook-handler.js';
import type { RuliuConfig } from './types.js';

// Mock ruliu-crypto
vi.mock('./ruliu-crypto.js', () => ({
  verifySignature: vi.fn(),
  decryptMessage: vi.fn(),
}));

import { verifySignature, decryptMessage } from './ruliu-crypto.js';

const mockVerifySignature = vi.mocked(verifySignature);
const mockDecryptMessage = vi.mocked(decryptMessage);

const testConfig: RuliuConfig = {
  apiHost: 'https://api.test.com',
  checkToken: 'test-check-token',
  encodingAESKey: 'dGVzdC1lbmNvZGluZy1hZXMta2V5',
  appKey: 'test-app-key',
  appSecret: 'test-app-secret',
  robotName: 'TestBot',
};

function createHandler() {
  return new RuliuWebhookHandler({
    config: testConfig,
    callbacks: {
      onMessage: vi.fn(),
    },
  });
}

describe('RuliuWebhookHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('handleWebhook', () => {
    it('should parse string body to JSON', async () => {
      const handler = createHandler();
      mockVerifySignature.mockReturnValue(true);
      mockDecryptMessage.mockReturnValue(JSON.stringify({
        content: 'hello',
        fromUsername: 'user1',
        msgType: 'text',
        chatId: 'chat1',
        msgId: 'msg1',
        createTime: 1234567890,
      }));

      const result = await handler.handleWebhook(
        '{"encrypt":"encrypted_data"}',
        { signature: 'sig', timestamp: '123', nonce: 'abc' }
      );

      expect(result.status).toBe(200);
      expect(result.body).toBe('success');
    });

    it('should verify signature and reject invalid ones', async () => {
      const handler = createHandler();
      mockVerifySignature.mockReturnValue(false);

      const result = await handler.handleWebhook(
        { encrypt: 'encrypted_data', signature: 'sig', timestamp: '123', nonce: 'abc' },
        { signature: 'sig', timestamp: '123', nonce: 'abc' }
      );

      expect(result.status).toBe(401);
      expect(result.body).toBe('Invalid signature');
    });

    it('should skip signature verification when query params missing', async () => {
      const handler = createHandler();
      mockDecryptMessage.mockReturnValue(JSON.stringify({
        content: 'hello',
        fromUsername: 'user1',
        msgType: 'text',
        chatId: 'chat1',
        msgId: 'msg1',
        createTime: 1234567890,
      }));

      const result = await handler.handleWebhook(
        { encrypt: 'encrypted_data', signature: '', timestamp: '', nonce: '' },
        {}
      );

      expect(result.status).toBe(200);
      expect(mockVerifySignature).not.toHaveBeenCalled();
    });

    it('should call onMessage callback for text messages', async () => {
      const onMessage = vi.fn();
      const handler = new RuliuWebhookHandler({
        config: testConfig,
        callbacks: { onMessage },
      });

      mockVerifySignature.mockReturnValue(true);
      mockDecryptMessage.mockReturnValue(JSON.stringify({
        content: 'hello world',
        fromUsername: 'user1',
        msgType: 'text',
        chatId: 'chat1',
        msgId: 'msg1',
        createTime: 1234567890,
      }));

      await handler.handleWebhook(
        { encrypt: 'encrypted_data', signature: 'sig', timestamp: '123', nonce: 'abc' },
        { signature: 'sig', timestamp: '123', nonce: 'abc' }
      );

      expect(onMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          fromuser: 'user1',
          mes: 'hello world',
          chatType: 'direct',
          messageId: 'msg1',
          timestamp: 1234567890,
        })
      );
    });

    it('should detect group chat when groupId is present', async () => {
      const onMessage = vi.fn();
      const handler = new RuliuWebhookHandler({
        config: testConfig,
        callbacks: { onMessage },
      });

      mockVerifySignature.mockReturnValue(true);
      mockDecryptMessage.mockReturnValue(JSON.stringify({
        content: 'group message',
        fromUsername: 'user1',
        msgType: 'text',
        chatId: 'chat1',
        groupId: '12345',
        msgId: 'msg1',
        createTime: 1234567890,
      }));

      await handler.handleWebhook(
        { encrypt: 'data', signature: 's', timestamp: 't', nonce: 'n' },
        { signature: 's', timestamp: 't', nonce: 'n' }
      );

      expect(onMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          chatType: 'group',
          groupId: 12345,
        })
      );
    });

    it('should detect @mention of robot', async () => {
      const onMessage = vi.fn();
      const handler = new RuliuWebhookHandler({
        config: testConfig,
        callbacks: { onMessage },
      });

      mockVerifySignature.mockReturnValue(true);
      mockDecryptMessage.mockReturnValue(JSON.stringify({
        content: '@[TestBot] hello',
        fromUsername: 'user1',
        msgType: 'text',
        chatId: 'chat1',
        msgId: 'msg1',
        createTime: 1234567890,
      }));

      await handler.handleWebhook(
        { encrypt: 'data', signature: 's', timestamp: 't', nonce: 'n' },
        { signature: 's', timestamp: 't', nonce: 'n' }
      );

      expect(onMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          wasMentioned: true,
        })
      );
    });

    it('should not detect mention when robot is not mentioned', async () => {
      const onMessage = vi.fn();
      const handler = new RuliuWebhookHandler({
        config: testConfig,
        callbacks: { onMessage },
      });

      mockVerifySignature.mockReturnValue(true);
      mockDecryptMessage.mockReturnValue(JSON.stringify({
        content: 'just a regular message',
        fromUsername: 'user1',
        msgType: 'text',
        chatId: 'chat1',
        msgId: 'msg1',
        createTime: 1234567890,
      }));

      await handler.handleWebhook(
        { encrypt: 'data', signature: 's', timestamp: 't', nonce: 'n' },
        { signature: 's', timestamp: 't', nonce: 'n' }
      );

      expect(onMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          wasMentioned: false,
        })
      );
    });

    it('should skip non-text/markdown messages', async () => {
      const onMessage = vi.fn();
      const handler = new RuliuWebhookHandler({
        config: testConfig,
        callbacks: { onMessage },
      });

      mockVerifySignature.mockReturnValue(true);
      mockDecryptMessage.mockReturnValue(JSON.stringify({
        content: '',
        fromUsername: 'user1',
        msgType: 'image',
        chatId: 'chat1',
        msgId: 'msg1',
        createTime: 1234567890,
      }));

      const result = await handler.handleWebhook(
        { encrypt: 'data', signature: 's', timestamp: 't', nonce: 'n' },
        { signature: 's', timestamp: 't', nonce: 'n' }
      );

      expect(result.status).toBe(200);
      expect(onMessage).not.toHaveBeenCalled();
    });

    it('should handle markdown message type', async () => {
      const onMessage = vi.fn();
      const handler = new RuliuWebhookHandler({
        config: testConfig,
        callbacks: { onMessage },
      });

      mockVerifySignature.mockReturnValue(true);
      mockDecryptMessage.mockReturnValue(JSON.stringify({
        content: '# Hello',
        fromUsername: 'user1',
        msgType: 'markdown',
        chatId: 'chat1',
        msgId: 'msg1',
        createTime: 1234567890,
      }));

      await handler.handleWebhook(
        { encrypt: 'data', signature: 's', timestamp: 't', nonce: 'n' },
        { signature: 's', timestamp: 't', nonce: 'n' }
      );

      expect(onMessage).toHaveBeenCalled();
    });

    it('should return 500 on internal error', async () => {
      const handler = createHandler();
      mockVerifySignature.mockReturnValue(true);
      mockDecryptMessage.mockImplementation(() => {
        throw new Error('Decryption failed');
      });

      const result = await handler.handleWebhook(
        { encrypt: 'data', signature: 's', timestamp: 't', nonce: 'n' },
        { signature: 's', timestamp: 't', nonce: 'n' }
      );

      expect(result.status).toBe(500);
      expect(result.body).toBe('Internal error');
    });

    it('should handle invalid JSON body string', async () => {
      const handler = createHandler();

      const result = await handler.handleWebhook(
        'not valid json',
        {}
      );

      expect(result.status).toBe(500);
    });
  });

  describe('handleUrlVerification', () => {
    it('should decrypt and return challenge', () => {
      const handler = createHandler();
      mockVerifySignature.mockReturnValue(true);
      mockDecryptMessage.mockReturnValue('challenge_token_123');

      const result = handler.handleUrlVerification(
        { encrypt: 'encrypted_data', signature: 'sig', timestamp: '123', nonce: 'abc' },
        { signature: 'sig', timestamp: '123', nonce: 'abc' }
      );

      expect(result.status).toBe(200);
      expect(result.body).toBe('challenge_token_123');
    });

    it('should parse string body', () => {
      const handler = createHandler();
      mockVerifySignature.mockReturnValue(true);
      mockDecryptMessage.mockReturnValue('challenge_result');

      const result = handler.handleUrlVerification(
        '{"encrypt":"data"}',
        { signature: 's', timestamp: 't', nonce: 'n' }
      );

      expect(result.status).toBe(200);
      expect(result.body).toBe('challenge_result');
    });

    it('should reject invalid signature', () => {
      const handler = createHandler();
      mockVerifySignature.mockReturnValue(false);

      const result = handler.handleUrlVerification(
        { encrypt: 'data', signature: 's', timestamp: 't', nonce: 'n' },
        { signature: 's', timestamp: 't', nonce: 'n' }
      );

      expect(result.status).toBe(401);
      expect(result.body).toBe('Invalid signature');
    });

    it('should return 500 on error', () => {
      const handler = createHandler();
      mockVerifySignature.mockReturnValue(true);
      mockDecryptMessage.mockImplementation(() => {
        throw new Error('Decryption error');
      });

      const result = handler.handleUrlVerification(
        { encrypt: 'data', signature: 's', timestamp: 't', nonce: 'n' },
        { signature: 's', timestamp: 't', nonce: 'n' }
      );

      expect(result.status).toBe(500);
    });

    it('should skip signature when query params missing', () => {
      const handler = createHandler();
      mockDecryptMessage.mockReturnValue('challenge_ok');

      const result = handler.handleUrlVerification(
        { encrypt: 'data', signature: '', timestamp: '', nonce: '' },
        {}
      );

      expect(result.status).toBe(200);
      expect(mockVerifySignature).not.toHaveBeenCalled();
    });
  });
});
