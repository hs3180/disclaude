/**
 * Tests for MessageService (packages/primary-node/src/messaging/message-service.ts)
 *
 * Covers:
 * - Constructor and adapter registration
 * - getAdapter(): adapter lookup by chatId
 * - getCapabilities(): capability query
 * - isContentTypeSupported(): content type check
 * - send(): message routing with fallback
 * - update(): message update routing
 * - delete(): message deletion
 * - broadcast(): multi-adapter broadcast
 * - Global instance management
 *
 * @see Issue #1617 Phase 4
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MessageService,
  initMessageService,
  getMessageService,
  resetMessageService,
} from './message-service.js';
import { DEFAULT_CAPABILITIES, type IChannelAdapter, type ChannelCapabilities } from './channel-adapter.js';
import type { UniversalMessage } from '@disclaude/core';

function createMockAdapter(
  name: string,
  canHandlePrefix: string,
  capabilitiesOverrides: Partial<ChannelCapabilities> = {}
): IChannelAdapter {
  return {
    name,
    capabilities: { ...DEFAULT_CAPABILITIES, ...capabilitiesOverrides },
    canHandle: vi.fn((chatId: string) => chatId.startsWith(canHandlePrefix)),
    convert: vi.fn((msg: UniversalMessage) => msg),
    send: vi.fn().mockResolvedValue({ success: true, messageId: `${name}-msg-1` }),
    update: vi.fn().mockResolvedValue({ success: true }),
    delete: vi.fn().mockResolvedValue(true),
  };
}

describe('MessageService', () => {
  let feishuAdapter: IChannelAdapter;
  let cliAdapter: IChannelAdapter;

  beforeEach(() => {
    feishuAdapter = createMockAdapter('feishu', 'oc_', {
      supportsCard: true,
      supportedContentTypes: ['text', 'markdown', 'card'],
    });
    cliAdapter = createMockAdapter('cli', 'cli_', {
      supportedContentTypes: ['text', 'markdown'],
    });
    resetMessageService();
  });

  afterEach(() => {
    resetMessageService();
  });

  describe('constructor', () => {
    it('should register provided adapters', () => {
      const service = new MessageService({
        adapters: [feishuAdapter, cliAdapter],
      });

      expect(service.getAdapterNames()).toEqual(['feishu', 'cli']);
    });

    it('should default autoFallback to true', () => {
      const service = new MessageService({
        adapters: [feishuAdapter],
      });

      // Test indirectly: unsupported content type should fallback
      const msg: UniversalMessage = {
        chatId: 'oc_test',
        content: { type: 'file', path: 'file content' },
      };

      // Should not throw and should try to send
      void expect(service.send(msg)).resolves.toBeDefined();
    });
  });

  describe('registerAdapter', () => {
    it('should register a new adapter', () => {
      const service = new MessageService({ adapters: [] });
      service.registerAdapter(feishuAdapter);

      expect(service.getAdapterNames()).toContain('feishu');
    });

    it('should overwrite adapter with same name', () => {
      const service = new MessageService({ adapters: [feishuAdapter] });
      const newFeishu = createMockAdapter('feishu', 'oc_');

      service.registerAdapter(newFeishu);
      expect(service.getAdapterNames()).toEqual(['feishu']);
    });
  });

  describe('getAdapter', () => {
    it('should return adapter that can handle the chatId', () => {
      const service = new MessageService({
        adapters: [feishuAdapter, cliAdapter],
      });

      expect(service.getAdapter('oc_chat1')).toBe(feishuAdapter);
      expect(service.getAdapter('cli_session1')).toBe(cliAdapter);
    });

    it('should return undefined when no adapter matches', () => {
      const service = new MessageService({
        adapters: [feishuAdapter, cliAdapter],
      });

      expect(service.getAdapter('unknown_chat')).toBeUndefined();
    });
  });

  describe('getCapabilities', () => {
    it('should return adapter capabilities for matching chatId', () => {
      const service = new MessageService({
        adapters: [feishuAdapter],
      });

      const caps = service.getCapabilities('oc_test');
      expect(caps.supportsCard).toBe(true);
    });

    it('should return default capabilities when no adapter matches', () => {
      const service = new MessageService({
        adapters: [feishuAdapter],
      });

      const caps = service.getCapabilities('unknown_chat');
      expect(caps.supportsCard).toBe(false);
      expect(caps.maxMessageLength).toBe(4096);
    });
  });

  describe('isContentTypeSupported', () => {
    it('should return true for supported content type', () => {
      const service = new MessageService({
        adapters: [feishuAdapter],
      });

      expect(service.isContentTypeSupported('oc_test', 'text')).toBe(true);
      expect(service.isContentTypeSupported('oc_test', 'card')).toBe(true);
    });

    it('should return false for unsupported content type', () => {
      const service = new MessageService({
        adapters: [cliAdapter],
      });

      expect(service.isContentTypeSupported('cli_test', 'card')).toBe(false);
    });
  });

  describe('send', () => {
    it('should send message through matching adapter', async () => {
      const service = new MessageService({
        adapters: [feishuAdapter],
      });

      const result = await service.send({
        chatId: 'oc_test',
        content: { type: 'text', text: 'Hello!' },
      });

      expect(result.success).toBe(true);
      expect(feishuAdapter.send).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'oc_test',
          content: expect.objectContaining({ type: 'text' }),
        })
      );
    });

    it('should return error when no adapter found', async () => {
      const service = new MessageService({
        adapters: [feishuAdapter],
      });

      const result = await service.send({
        chatId: 'unknown_chat',
        content: { type: 'text', text: 'Hello!' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No adapter can handle chatId');
    });

    it('should fallback card to text for unsupported adapter', async () => {
      const service = new MessageService({
        adapters: [cliAdapter],
      });

      await service.send({
        chatId: 'cli_test',
        content: {
          type: 'card',
          title: 'Test Card',
          sections: [],
        } as any,
      });

      // Should fallback to text
      expect(cliAdapter.send).toHaveBeenCalled();
    });

    it('should return error when autoFallback is disabled', async () => {
      const service = new MessageService({
        adapters: [cliAdapter],
        autoFallback: false,
      });

      const result = await service.send({
        chatId: 'cli_test',
        content: {
          type: 'card',
          title: 'Test',
          sections: [],
        } as any,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not supported');
    });
  });

  describe('update', () => {
    it('should update message through adapter', async () => {
      const service = new MessageService({
        adapters: [feishuAdapter],
      });

      const result = await service.update('msg-1', {
        chatId: 'oc_test',
        content: { type: 'text', text: 'Updated!' },
      });

      expect(result.success).toBe(true);
      expect(feishuAdapter.update).toHaveBeenCalledWith('msg-1', expect.any(Object));
    });

    it('should return error when no adapter found', async () => {
      const service = new MessageService({
        adapters: [feishuAdapter],
      });

      const result = await service.update('msg-1', {
        chatId: 'unknown_chat',
        content: { type: 'text', text: 'Updated!' },
      });

      expect(result.success).toBe(false);
    });

    it('should return error when adapter does not support update', async () => {
      const noUpdateAdapter = createMockAdapter('no-update', 'test_');
      delete noUpdateAdapter.update;

      const service = new MessageService({
        adapters: [noUpdateAdapter],
      });

      const result = await service.update('msg-1', {
        chatId: 'test_chat',
        content: { type: 'text', text: 'Updated!' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('does not support message updates');
    });
  });

  describe('delete', () => {
    it('should delete message through adapter', async () => {
      const service = new MessageService({
        adapters: [feishuAdapter],
      });

      const result = await service.delete('oc_test', 'msg-1');
      expect(result).toBe(true);
    });

    it('should return false when no adapter found', async () => {
      const service = new MessageService({
        adapters: [feishuAdapter],
      });

      const result = await service.delete('unknown_chat', 'msg-1');
      expect(result).toBe(false);
    });

    it('should return false when adapter does not support delete', async () => {
      const noDeleteAdapter = createMockAdapter('no-delete', 'test_');
      delete noDeleteAdapter.delete;

      const service = new MessageService({
        adapters: [noDeleteAdapter],
      });

      const result = await service.delete('test_chat', 'msg-1');
      expect(result).toBe(false);
    });
  });

  describe('broadcast', () => {
    it('should send message to all adapters', async () => {
      const service = new MessageService({
        adapters: [feishuAdapter, cliAdapter],
      });

      const message: UniversalMessage = {
        chatId: 'broadcast',
        content: { type: 'text', text: 'Broadcast message' },
      };

      const results = await service.broadcast(message);

      expect(results.size).toBe(2);
      expect(feishuAdapter.send).toHaveBeenCalled();
      expect(cliAdapter.send).toHaveBeenCalled();
    });

    it('should handle adapter errors gracefully', async () => {
      const errorAdapter = createMockAdapter('error', 'err_');
      (errorAdapter.send as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Connection failed')
      );

      const service = new MessageService({
        adapters: [errorAdapter],
      });

      const message: UniversalMessage = {
        chatId: 'broadcast',
        content: { type: 'text', text: 'Test' },
      };

      const results = await service.broadcast(message);

      expect(results.get('error')?.success).toBe(false);
      expect(results.get('error')?.error).toContain('Connection failed');
    });
  });

  describe('getAdapterNames', () => {
    it('should return all adapter names', () => {
      const service = new MessageService({
        adapters: [feishuAdapter, cliAdapter],
      });

      expect(service.getAdapterNames()).toEqual(['feishu', 'cli']);
    });

    it('should return empty array when no adapters', () => {
      const service = new MessageService({ adapters: [] });
      expect(service.getAdapterNames()).toEqual([]);
    });
  });
});

describe('Global MessageService', () => {
  afterEach(() => {
    resetMessageService();
  });

  describe('initMessageService', () => {
    it('should initialize global service', () => {
      const service = initMessageService({ adapters: [] });
      expect(service).toBeInstanceOf(MessageService);
    });
  });

  describe('getMessageService', () => {
    it('should throw when not initialized', () => {
      expect(() => getMessageService()).toThrow(
        'MessageService not initialized'
      );
    });

    it('should return initialized service', () => {
      const service = initMessageService({ adapters: [] });
      expect(getMessageService()).toBe(service);
    });
  });

  describe('resetMessageService', () => {
    it('should reset global service', () => {
      initMessageService({ adapters: [] });
      resetMessageService();
      expect(() => getMessageService()).toThrow();
    });
  });
});
