/**
 * Tests for RoutedOutputAdapter and SimpleUserOutputAdapter
 *
 * @see Issue #1617 Phase 4
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  RoutedOutputAdapter,
  SimpleUserOutputAdapter,
} from './routed-output-adapter.js';
import type { IMessageRouter } from './types.js';
import { MessageLevel } from './types.js';

function createMockRouter(): IMessageRouter {
  return {
    route: vi.fn().mockResolvedValue(undefined),
    getTargets: vi.fn(() => ['user-chat']),
    getUserChatId: vi.fn(() => 'user-chat'),
  };
}

describe('RoutedOutputAdapter', () => {
  let router: IMessageRouter;
  let adapter: RoutedOutputAdapter;

  beforeEach(() => {
    router = createMockRouter();
    adapter = new RoutedOutputAdapter({ router });
  });

  describe('constructor', () => {
    it('should store options', () => {
      const a = new RoutedOutputAdapter({ router, defaultChatId: 'test-chat', debug: true });
      expect(a.getDefaultChatId()).toBe('test-chat');
      expect(a.isDebugEnabled()).toBe(true);
    });

    it('should default debug to false', () => {
      expect(adapter.isDebugEnabled()).toBe(false);
    });
  });

  describe('write', () => {
    it('should skip empty content', async () => {
      await adapter.write('   ', 'text');
      expect(router.route).not.toHaveBeenCalled();
    });

    it('should route text messages', async () => {
      await adapter.write('Hello world', 'text');
      expect(router.route).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Hello world',
        })
      );
    });

    it('should map message types to levels', async () => {
      await adapter.write('Error occurred', 'error');
      expect(router.route).toHaveBeenCalledWith(
        expect.objectContaining({
          level: MessageLevel.ERROR,
        })
      );
    });

    it('should throttle progress messages', async () => {
      const metadata = { toolName: 'tool1' };
      await adapter.write('Progress 1', 'tool_progress', metadata);
      // Second call within throttle interval should be skipped
      await adapter.write('Progress 2', 'tool_progress', metadata);
      expect(router.route).toHaveBeenCalledTimes(1);
    });

    it('should track user-visible messages', async () => {
      (router.getTargets as ReturnType<typeof vi.fn>).mockReturnValue(['user-chat']);
      await adapter.write('Result message', 'result');
      expect(adapter.hasSentUserMessage()).toBe(true);
    });

    it('should not track non-user-visible messages', async () => {
      (router.getTargets as ReturnType<typeof vi.fn>).mockReturnValue(['admin-chat']);
      await adapter.write('Debug info', 'tool_use');
      expect(adapter.hasSentUserMessage()).toBe(false);
    });
  });

  describe('resetTracking', () => {
    it('should reset user message tracking', async () => {
      (router.getTargets as ReturnType<typeof vi.fn>).mockReturnValue(['user-chat']);
      await adapter.write('Result', 'result');
      expect(adapter.hasSentUserMessage()).toBe(true);

      adapter.resetTracking();
      expect(adapter.hasSentUserMessage()).toBe(false);
    });
  });

  describe('hasSentUserMessage', () => {
    it('should return false initially', () => {
      expect(adapter.hasSentUserMessage()).toBe(false);
    });
  });
});

describe('SimpleUserOutputAdapter', () => {
  it('should send text to the chat', async () => {
    const sendText = vi.fn().mockResolvedValue(undefined);
    const adapter = new SimpleUserOutputAdapter(sendText, 'chat-123');

    await adapter.write('Hello', 'text');
    expect(sendText).toHaveBeenCalledWith('chat-123', 'Hello');
  });

  it('should skip empty content', async () => {
    const sendText = vi.fn().mockResolvedValue(undefined);
    const adapter = new SimpleUserOutputAdapter(sendText, 'chat-123');

    await adapter.write('   ', 'text');
    expect(sendText).not.toHaveBeenCalled();
  });

  it('should trim content', async () => {
    const sendText = vi.fn().mockResolvedValue(undefined);
    const adapter = new SimpleUserOutputAdapter(sendText, 'chat-123');

    await adapter.write('  Hello  ', 'text');
    expect(sendText).toHaveBeenCalledWith('chat-123', 'Hello');
  });
});
