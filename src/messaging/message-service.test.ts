/**
 * Tests for Message Service.
 *
 * Issue #515: Universal Message Format + Channel Adapters (Phase 2)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageService, resetMessageService } from './message-service.js';
import { CliAdapter } from './adapters/cli-adapter.js';
import { RestAdapter } from './adapters/rest-adapter.js';
import type { IChannelAdapter, ChannelCapabilities } from './channel-adapter.js';
import type { UniversalMessage, SendResult } from './universal-message.js';

// Mock adapter for testing
class MockAdapter implements IChannelAdapter {
  name: string;
  capabilities: ChannelCapabilities;
  canHandleFn: (chatId: string) => boolean;
  sendFn: (message: UniversalMessage) => Promise<SendResult>;

  constructor(
    name: string,
    canHandle: (chatId: string) => boolean,
    send: (message: UniversalMessage) => Promise<SendResult>,
    capabilities?: Partial<ChannelCapabilities>
  ) {
    this.name = name;
    this.canHandleFn = canHandle;
    this.sendFn = send;
    this.capabilities = {
      supportsCard: false,
      supportsThread: false,
      supportsFile: false,
      supportsMarkdown: true,
      maxMessageLength: 4096,
      supportedContentTypes: ['text', 'markdown'],
      supportsUpdate: false,
      supportsDelete: false,
      supportsMention: false,
      supportsReactions: false,
      ...capabilities,
    };
  }

  canHandle(chatId: string): boolean {
    return this.canHandleFn(chatId);
  }

  convert(message: UniversalMessage): unknown {
    return message;
  }

  async send(message: UniversalMessage): Promise<SendResult> {
    return await this.sendFn(message);
  }
}

describe('MessageService', () => {
  let service: MessageService;

  beforeEach(() => {
    resetMessageService();
  });

  describe('constructor', () => {
    it('should register adapters', () => {
      const adapter = new MockAdapter(
        'mock',
        () => true,
        () => Promise.resolve({ success: true })
      );
      service = new MessageService({ adapters: [adapter] });
      expect(service.getAdapterNames()).toContain('mock');
    });

    it('should register multiple adapters', () => {
      const adapter1 = new MockAdapter('mock1', () => false, () => Promise.resolve({ success: true }));
      const adapter2 = new MockAdapter('mock2', () => true, () => Promise.resolve({ success: true }));
      service = new MessageService({ adapters: [adapter1, adapter2] });
      expect(service.getAdapterNames()).toHaveLength(2);
    });
  });

  describe('registerAdapter', () => {
    it('should add new adapter', () => {
      service = new MessageService({ adapters: [] });
      const adapter = new MockAdapter('mock', () => true, () => Promise.resolve({ success: true }));
      service.registerAdapter(adapter);
      expect(service.getAdapterNames()).toContain('mock');
    });
  });

  describe('getAdapter', () => {
    it('should return adapter that can handle chatId', () => {
      const adapter = new MockAdapter(
        'mock',
        (chatId) => chatId.startsWith('test_'),
        () => Promise.resolve({ success: true })
      );
      service = new MessageService({ adapters: [adapter] });

      expect(service.getAdapter('test_123')).toBe(adapter);
      expect(service.getAdapter('other_123')).toBeUndefined();
    });
  });

  describe('getCapabilities', () => {
    it('should return adapter capabilities', () => {
      const adapter = new MockAdapter(
        'mock',
        () => true,
        () => Promise.resolve({ success: true }),
        { supportsCard: true, maxMessageLength: 10000 }
      );
      service = new MessageService({ adapters: [adapter] });

      const caps = service.getCapabilities('any_id');
      expect(caps.supportsCard).toBe(true);
      expect(caps.maxMessageLength).toBe(10000);
    });

    it('should return default capabilities for unknown chatId', () => {
      service = new MessageService({ adapters: [] });
      const caps = service.getCapabilities('unknown');
      expect(caps.supportsCard).toBe(false);
      expect(caps.maxMessageLength).toBe(4096);
    });
  });

  describe('send', () => {
    it('should send message via correct adapter', async () => {
      const sendMock = vi.fn().mockResolvedValue({ success: true, messageId: 'msg_123' });
      const adapter = new MockAdapter('mock', () => true, sendMock);
      service = new MessageService({ adapters: [adapter] });

      const msg: UniversalMessage = {
        chatId: 'test_chat',
        content: { type: 'text', text: 'Hello' },
      };

      const result = await service.send(msg);
      expect(result.success).toBe(true);
      expect(sendMock).toHaveBeenCalledWith(msg);
    });

    it('should return error for unknown chatId', async () => {
      const adapter = new MockAdapter('mock', () => false, () => Promise.resolve({ success: true }));
      service = new MessageService({ adapters: [adapter] });

      const msg: UniversalMessage = {
        chatId: 'unknown_chat',
        content: { type: 'text', text: 'Hello' },
      };

      const result = await service.send(msg);
      expect(result.success).toBe(false);
      expect(result.error).toContain('No adapter');
    });

    it('should fallback card to text when not supported', async () => {
      const sendMock = vi.fn().mockResolvedValue({ success: true });
      const adapter = new MockAdapter(
        'mock',
        () => true,
        sendMock,
        { supportedContentTypes: ['text'] }
      );
      service = new MessageService({ adapters: [adapter], autoFallback: true });

      const msg: UniversalMessage = {
        chatId: 'test_chat',
        content: {
          type: 'card',
          title: 'Title',
          sections: [{ type: 'text', content: 'Content' }],
        },
      };

      await service.send(msg);
      expect(sendMock).toHaveBeenCalled();
      const sentMsg = sendMock.mock.calls[0][0] as UniversalMessage;
      expect(sentMsg.content.type).toBe('text');
    });

    it('should not fallback when autoFallback is false', async () => {
      const sendMock = vi.fn().mockResolvedValue({ success: true });
      const adapter = new MockAdapter(
        'mock',
        () => true,
        sendMock,
        { supportedContentTypes: ['text'] }
      );
      service = new MessageService({ adapters: [adapter], autoFallback: false });

      const msg: UniversalMessage = {
        chatId: 'test_chat',
        content: {
          type: 'card',
          title: 'Title',
          sections: [],
        },
      };

      const result = await service.send(msg);
      expect(result.success).toBe(false);
      expect(result.error).toContain('not supported');
    });
  });

  describe('update', () => {
    it('should update message if adapter supports it', async () => {
      const updateMock = vi.fn().mockResolvedValue({ success: true });
      const adapter = new MockAdapter('mock', () => true, () => Promise.resolve({ success: true }));
      (adapter as any).update = updateMock;
      service = new MessageService({ adapters: [adapter] });

      const msg: UniversalMessage = {
        chatId: 'test_chat',
        content: { type: 'text', text: 'Updated' },
      };

      await service.update('msg_123', msg);
      expect(updateMock).toHaveBeenCalledWith('msg_123', msg);
    });

    it('should return error if adapter does not support update', async () => {
      const adapter = new MockAdapter('mock', () => true, () => Promise.resolve({ success: true }));
      service = new MessageService({ adapters: [adapter] });

      const msg: UniversalMessage = {
        chatId: 'test_chat',
        content: { type: 'text', text: 'Updated' },
      };

      const result = await service.update('msg_123', msg);
      expect(result.success).toBe(false);
      expect(result.error).toContain('does not support');
    });
  });

  describe('delete', () => {
    it('should delete message if adapter supports it', async () => {
      const deleteMock = vi.fn().mockResolvedValue(true);
      const adapter = new MockAdapter('mock', () => true, () => Promise.resolve({ success: true }));
      (adapter as any).delete = deleteMock;
      service = new MessageService({ adapters: [adapter] });

      const result = await service.delete('test_chat', 'msg_123');
      expect(result).toBe(true);
    });

    it('should return false if adapter does not support delete', async () => {
      const adapter = new MockAdapter('mock', () => true, () => Promise.resolve({ success: true }));
      service = new MessageService({ adapters: [adapter] });

      const result = await service.delete('test_chat', 'msg_123');
      expect(result).toBe(false);
    });
  });

  describe('broadcast', () => {
    it('should send message to all adapters', async () => {
      const sendMock1 = vi.fn().mockResolvedValue({ success: true });
      const sendMock2 = vi.fn().mockResolvedValue({ success: true });
      const adapter1 = new MockAdapter('mock1', () => true, sendMock1);
      const adapter2 = new MockAdapter('mock2', () => true, sendMock2);
      service = new MessageService({ adapters: [adapter1, adapter2] });

      const msg: UniversalMessage = {
        chatId: 'broadcast',
        content: { type: 'text', text: 'Broadcast' },
      };

      const results = await service.broadcast(msg);
      expect(results.size).toBe(2);
      expect(results.get('mock1')?.success).toBe(true);
      expect(results.get('mock2')?.success).toBe(true);
    });

    it('should handle adapter failures', async () => {
      const sendMock1 = vi.fn().mockResolvedValue({ success: true });
      const sendMock2 = vi.fn().mockRejectedValue(new Error('Failed'));
      const adapter1 = new MockAdapter('mock1', () => true, sendMock1);
      const adapter2 = new MockAdapter('mock2', () => true, sendMock2);
      service = new MessageService({ adapters: [adapter1, adapter2] });

      const msg: UniversalMessage = {
        chatId: 'broadcast',
        content: { type: 'text', text: 'Broadcast' },
      };

      const results = await service.broadcast(msg);
      expect(results.get('mock1')?.success).toBe(true);
      expect(results.get('mock2')?.success).toBe(false);
    });
  });

  describe('with real adapters', () => {
    it('should route to CLI adapter', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      service = new MessageService({ adapters: [new CliAdapter()] });

      const msg: UniversalMessage = {
        chatId: 'cli-test',
        content: { type: 'text', text: 'CLI message' },
      };

      const result = await service.send(msg);
      expect(result.success).toBe(true);
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should route to REST adapter', async () => {
      service = new MessageService({ adapters: [new RestAdapter()] });

      const msg: UniversalMessage = {
        chatId: '123e4567-e89b-12d3-a456-426614174000',
        content: { type: 'text', text: 'REST message' },
      };

      const result = await service.send(msg);
      expect(result.success).toBe(true);
    });
  });
});
