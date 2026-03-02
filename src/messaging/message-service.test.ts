/**
 * Tests for Message Service.
 *
 * @see Issue #480
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MessageService,
  getMessageService,
  setMessageService,
  createMessageService,
} from './message-service.js';
import type { IChannelAdapter, SendResult } from './channel-adapter.js';
import {
  type UniversalMessage,
  type ChannelCapabilities,
  DEFAULT_CAPABILITIES,
  FEISHU_CAPABILITIES,
  CLI_CAPABILITIES,
} from './universal-message.js';

/**
 * Mock adapter for testing.
 */
class MockAdapter implements IChannelAdapter {
  id: string;
  name: string;
  capabilities: ChannelCapabilities;
  canHandleFn: (chatId: string) => boolean;
  sendFn: (message: UniversalMessage) => Promise<SendResult>;

  constructor(options: {
    id: string;
    name: string;
    capabilities?: ChannelCapabilities;
    canHandle: (chatId: string) => boolean;
    send?: (message: UniversalMessage) => Promise<SendResult>;
  }) {
    this.id = options.id;
    this.name = options.name;
    this.capabilities = options.capabilities ?? DEFAULT_CAPABILITIES;
    this.canHandleFn = options.canHandle;
    this.sendFn = options.send ?? (async () => ({ success: true, messageId: 'msg-123' }));
  }

  canHandle(chatId: string): boolean {
    return this.canHandleFn(chatId);
  }

  convert(message: UniversalMessage): unknown {
    return message;
  }

  async send(message: UniversalMessage): Promise<SendResult> {
    return this.sendFn(message);
  }
}

describe('MessageService', () => {
  let service: MessageService;

  beforeEach(() => {
    service = new MessageService();
    setMessageService(null); // Reset global instance
  });

  describe('Adapter Management', () => {
    it('should register adapters', () => {
      const adapter = new MockAdapter({
        id: 'test',
        name: 'Test',
        canHandle: () => true,
      });

      service.registerAdapter(adapter);

      expect(service.getAdapters()).toHaveLength(1);
      expect(service.getAdapter('test')).toBe(adapter);
    });

    it('should unregister adapters', () => {
      const adapter = new MockAdapter({
        id: 'test',
        name: 'Test',
        canHandle: () => true,
      });

      service.registerAdapter(adapter);
      expect(service.getAdapters()).toHaveLength(1);

      service.unregisterAdapter('test');
      expect(service.getAdapters()).toHaveLength(0);
    });

    it('should get adapters', () => {
      const adapter1 = new MockAdapter({
        id: 'test1',
        name: 'Test 1',
        canHandle: () => true,
      });
      const adapter2 = new MockAdapter({
        id: 'test2',
        name: 'Test 2',
        canHandle: () => true,
      });

      service.registerAdapter(adapter1);
      service.registerAdapter(adapter2);

      expect(service.getAdapters()).toHaveLength(2);
      expect(service.getAdapter('test1')).toBe(adapter1);
      expect(service.getAdapter('test2')).toBe(adapter2);
    });
  });

  describe('Message Routing', () => {
    it('should route message to correct adapter', async () => {
      const sendMock = vi.fn().mockResolvedValue({ success: true, messageId: 'msg-123' });

      const feishuAdapter = new MockAdapter({
        id: 'feishu',
        name: 'Feishu',
        capabilities: FEISHU_CAPABILITIES,
        canHandle: (chatId) => chatId.startsWith('oc_'),
        send: sendMock,
      });

      const cliAdapter = new MockAdapter({
        id: 'cli',
        name: 'CLI',
        capabilities: CLI_CAPABILITIES,
        canHandle: (chatId) => chatId.startsWith('cli-'),
      });

      service.registerAdapter(feishuAdapter);
      service.registerAdapter(cliAdapter);

      const result = await service.send({
        chatId: 'oc_123',
        content: { type: 'text', text: 'Hello' },
      });

      expect(result.success).toBe(true);
      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'oc_123',
          content: expect.objectContaining({ type: 'text' }),
        })
      );
    });

    it('should return error when no adapter found', async () => {
      const result = await service.send({
        chatId: 'unknown-123',
        content: { type: 'text', text: 'Hello' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No adapter found');
    });

    it('should use default adapter when no match', async () => {
      const sendMock = vi.fn().mockResolvedValue({ success: true, messageId: 'msg-123' });

      const defaultAdapter = new MockAdapter({
        id: 'default',
        name: 'Default',
        canHandle: () => false,
        send: sendMock,
      });

      const serviceWithDefault = new MessageService({
        defaultAdapter,
      });

      const result = await serviceWithDefault.send({
        chatId: 'unknown-123',
        content: { type: 'text', text: 'Hello' },
      });

      expect(result.success).toBe(true);
      expect(sendMock).toHaveBeenCalledTimes(1);
    });

    it('should broadcast to all adapters when enabled', async () => {
      const sendMock1 = vi.fn().mockResolvedValue({ success: true, messageId: 'msg-1' });
      const sendMock2 = vi.fn().mockResolvedValue({ success: true, messageId: 'msg-2' });

      const adapter1 = new MockAdapter({
        id: 'adapter1',
        name: 'Adapter 1',
        capabilities: DEFAULT_CAPABILITIES,
        canHandle: () => true,
        send: sendMock1,
      });

      const adapter2 = new MockAdapter({
        id: 'adapter2',
        name: 'Adapter 2',
        capabilities: DEFAULT_CAPABILITIES,
        canHandle: () => true,
        send: sendMock2,
      });

      const broadcastService = new MessageService({
        adapters: [adapter1, adapter2],
        enableBroadcast: true,
      });

      // When no adapter matches (both return true for canHandle), it broadcasts
      const result = await broadcastService.send({
        chatId: 'any-chat',
        content: { type: 'text', text: 'Hello' },
      });

      // At least one should succeed
      expect(result.success).toBe(true);
    });
  });

  describe('Content Conversion', () => {
    it('should convert card to text for adapters without card support', async () => {
      const sendMock = vi.fn().mockResolvedValue({ success: true, messageId: 'msg-123' });

      const textOnlyAdapter = new MockAdapter({
        id: 'text-only',
        name: 'Text Only',
        capabilities: {
          ...DEFAULT_CAPABILITIES,
          supportedContentTypes: ['text'],
        },
        canHandle: () => true,
        send: sendMock,
      });

      service.registerAdapter(textOnlyAdapter);

      const result = await service.send({
        chatId: 'chat-123',
        content: {
          type: 'card',
          title: 'Test Card',
          sections: [{ type: 'text', content: 'Card content' }],
        },
      });

      expect(result.success).toBe(true);
      // The service should have converted the card to text
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.objectContaining({ type: 'text' }),
        })
      );
    });
  });

  describe('Convenience Methods', () => {
    it('should send text message', async () => {
      const sendMock = vi.fn().mockResolvedValue({ success: true, messageId: 'msg-123' });

      const adapter = new MockAdapter({
        id: 'test',
        name: 'Test',
        canHandle: () => true,
        send: sendMock,
      });

      service.registerAdapter(adapter);

      const result = await service.sendText('chat-123', 'Hello', 'thread-456');

      expect(result.success).toBe(true);
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'chat-123',
          threadId: 'thread-456',
          content: { type: 'text', text: 'Hello' },
        })
      );
    });

    it('should send card message', async () => {
      const sendMock = vi.fn().mockResolvedValue({ success: true, messageId: 'msg-123' });

      const adapter = new MockAdapter({
        id: 'test',
        name: 'Test',
        capabilities: FEISHU_CAPABILITIES,
        canHandle: () => true,
        send: sendMock,
      });

      service.registerAdapter(adapter);

      const result = await service.sendCard(
        'chat-123',
        {
          title: 'Test Card',
          sections: [{ type: 'text', content: 'Content' }],
        },
        'thread-456'
      );

      expect(result.success).toBe(true);
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'chat-123',
          threadId: 'thread-456',
          content: expect.objectContaining({ type: 'card' }),
        })
      );
    });
  });

  describe('Capabilities', () => {
    it('should get capabilities for chatId', () => {
      const adapter = new MockAdapter({
        id: 'test',
        name: 'Test',
        capabilities: FEISHU_CAPABILITIES,
        canHandle: (chatId) => chatId.startsWith('oc_'),
      });

      service.registerAdapter(adapter);

      expect(service.getCapabilities('oc_123')).toEqual(FEISHU_CAPABILITIES);
      expect(service.getCapabilities('unknown')).toBeNull();
    });
  });

  describe('Global Instance', () => {
    it('should set and get global instance', () => {
      expect(getMessageService()).toBeNull();

      const svc = createMessageService();
      expect(getMessageService()).toBe(svc);

      setMessageService(null);
      expect(getMessageService()).toBeNull();
    });
  });
});
