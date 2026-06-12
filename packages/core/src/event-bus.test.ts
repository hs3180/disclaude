import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InternalEventBus } from './event-bus.js';

describe('InternalEventBus', () => {
  let bus: InternalEventBus;

  beforeEach(() => {
    bus = new InternalEventBus();
  });

  it('should deliver events to registered handlers', async () => {
    const handler = vi.fn();
    bus.on('feishu.topic.message', handler);

    const payload = {
      type: 'topic_group_message' as const,
      chatId: 'oc_test',
      rootId: 'om_root',
      threadId: 'om_thread',
      sender: { name: 'Alice' },
      content: 'Hello',
      isReply: false,
      timestamp: '2026-06-13T00:00:00Z',
    };

    bus.emit('feishu.topic.message', payload);

    // Handlers run async
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });
    expect(handler).toHaveBeenCalledWith(payload);
  });

  it('should support multiple handlers for the same event', async () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    bus.on('feishu.topic.message', handler1);
    bus.on('feishu.topic.message', handler2);

    bus.emit('feishu.topic.message', {
      type: 'topic_group_message',
      chatId: 'oc_test',
      rootId: 'om_root',
      threadId: 'om_thread',
      sender: {},
      content: 'test',
      isReply: false,
      timestamp: '',
    });

    await vi.waitFor(() => {
      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });
  });

  it('should unsubscribe via returned function', async () => {
    const handler = vi.fn();
    const unsub = bus.on('feishu.topic.message', handler);

    unsub();

    bus.emit('feishu.topic.message', {
      type: 'topic_group_message',
      chatId: 'oc_test',
      rootId: '',
      threadId: '',
      sender: {},
      content: '',
      isReply: false,
      timestamp: '',
    });

    // Give async handlers a chance
    await new Promise((r) => setTimeout(r, 10));
    expect(handler).not.toHaveBeenCalled();
  });

  it('should unsubscribe via off()', async () => {
    const handler = vi.fn();
    bus.on('feishu.topic.message', handler);
    bus.off('feishu.topic.message', handler);

    bus.emit('feishu.topic.message', {
      type: 'topic_group_message',
      chatId: 'oc_test',
      rootId: '',
      threadId: '',
      sender: {},
      content: '',
      isReply: false,
      timestamp: '',
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(handler).not.toHaveBeenCalled();
  });

  it('should isolate handler errors', async () => {
    const errorHandler = vi.fn(() => {
      throw new Error('handler failed');
    });
    const normalHandler = vi.fn();

    bus.on('feishu.topic.message', errorHandler);
    bus.on('feishu.topic.message', normalHandler);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    bus.emit('feishu.topic.message', {
      type: 'topic_group_message',
      chatId: 'oc_test',
      rootId: '',
      threadId: '',
      sender: {},
      content: '',
      isReply: false,
      timestamp: '',
    });

    await vi.waitFor(() => {
      expect(normalHandler).toHaveBeenCalledTimes(1);
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Handler error'),
      expect.any(String),
    );
    warnSpy.mockRestore();
  });

  it('should not throw when emitting event with no handlers', () => {
    expect(() => {
      bus.emit('feishu.topic.message', {
        type: 'topic_group_message',
        chatId: '',
        rootId: '',
        threadId: '',
        sender: {},
        content: '',
        isReply: false,
        timestamp: '',
      });
    }).not.toThrow();
  });

  it('should clear handlers with removeAllListeners(event)', () => {
    const handler = vi.fn();
    bus.on('feishu.topic.message', handler);

    expect(bus.listenerCount('feishu.topic.message')).toBe(1);
    bus.removeAllListeners('feishu.topic.message');
    expect(bus.listenerCount('feishu.topic.message')).toBe(0);
  });

  it('should clear all handlers with removeAllListeners()', () => {
    bus.on('feishu.topic.message', vi.fn());
    bus.on('feishu.card.action', vi.fn());

    bus.removeAllListeners();

    expect(bus.listenerCount('feishu.topic.message')).toBe(0);
    expect(bus.listenerCount('feishu.card.action')).toBe(0);
  });

  it('should report correct listenerCount', () => {
    expect(bus.listenerCount('feishu.topic.message')).toBe(0);

    const unsub1 = bus.on('feishu.topic.message', vi.fn());
    expect(bus.listenerCount('feishu.topic.message')).toBe(1);

    const unsub2 = bus.on('feishu.topic.message', vi.fn());
    expect(bus.listenerCount('feishu.topic.message')).toBe(2);

    unsub1();
    expect(bus.listenerCount('feishu.topic.message')).toBe(1);

    unsub2();
    expect(bus.listenerCount('feishu.topic.message')).toBe(0);
  });
});
