/**
 * Unit tests for BaseChannel abstract class.
 *
 * Issue #1617 Phase 1: Tests for core channels module.
 *
 * Uses a concrete TestChannel implementation to verify:
 * - Lifecycle management (start, stop, status transitions)
 * - Handler registration (message, control)
 * - Error handling and validation
 * - State management
 */

import { describe, it, expect, vi } from 'vitest';
import { BaseChannel } from './base-channel.js';
import type {
  ChannelConfig,
  OutgoingMessage,
  MessageHandler,
  ControlHandler,
  ControlResponse,
  IncomingMessage,
} from '../types/channel.js';

// ============================================================================
// Concrete test implementation
// ============================================================================

type TestChannelConfig = ChannelConfig & { testData?: string };

class TestChannel extends BaseChannel<TestChannelConfig> {
  public doStartCalls = 0;
  public doStopCalls = 0;
  public doSendMessageCalls: OutgoingMessage[] = [];
  public healthy = true;
  public shouldFailStart = false;
  public shouldFailStop = false;
  public shouldFailSend = false;

  // eslint-disable-next-line require-await
  protected async doStart(): Promise<void> {
    this.doStartCalls++;
    if (this.shouldFailStart) {
      throw new Error('Start failed');
    }
  }

  // eslint-disable-next-line require-await
  protected async doStop(): Promise<void> {
    this.doStopCalls++;
    if (this.shouldFailStop) {
      throw new Error('Stop failed');
    }
  }

  // eslint-disable-next-line require-await
  protected async doSendMessage(message: OutgoingMessage): Promise<void> {
    this.doSendMessageCalls.push(message);
    if (this.shouldFailSend) {
      throw new Error('Send failed');
    }
  }

  protected checkHealth(): boolean {
    return this.healthy;
  }

  /** Expose isRunning for testing */
  get testIsRunning(): boolean {
    return (this as unknown as { isRunning: boolean }).isRunning;
  }

  /** Expose protected emitMessage for testing */
  // eslint-disable-next-line require-await
  async testEmitMessage(message: IncomingMessage): Promise<void> {
    return this.emitMessage(message);
  }

  /** Expose protected emitControl for testing */
  // eslint-disable-next-line require-await
  async testEmitControl(command: Parameters<ControlHandler>[0]): Promise<ControlResponse> {
    return this.emitControl(command);
  }
}

function createTestChannel(config?: Partial<TestChannelConfig>): TestChannel {
  return new TestChannel(
    { ...config, id: config?.id || 'test-channel' },
    'default-id',
    'TestChannel'
  );
}

// ============================================================================
// Tests
// ============================================================================

describe('BaseChannel', () => {
  describe('construction', () => {
    it('should set id from config when provided', () => {
      const channel = createTestChannel({ id: 'custom-id' });
      expect(channel.id).toBe('custom-id');
    });

    it('should use default id when not in config', () => {
      const channel = createTestChannel();
      expect(channel.id).toBe('test-channel');
    });

    it('should set name from constructor', () => {
      const channel = createTestChannel();
      expect(channel.name).toBe('TestChannel');
    });

    it('should have stopped status initially', () => {
      const channel = createTestChannel();
      expect(channel.status).toBe('stopped');
    });
  });

  describe('start', () => {
    it('should transition from stopped to running', async () => {
      const channel = createTestChannel();
      await channel.start();
      expect(channel.status).toBe('running');
      expect(channel.doStartCalls).toBe(1);
    });

    it('should emit started event', async () => {
      const channel = createTestChannel();
      const listener = vi.fn();
      channel.on('started', listener);
      await channel.start();
      expect(listener).toHaveBeenCalledOnce();
    });

    it('should be no-op when already running', async () => {
      const channel = createTestChannel();
      await channel.start();
      await channel.start(); // second start
      expect(channel.doStartCalls).toBe(1);
      expect(channel.status).toBe('running');
    });

    it('should transition to error state on start failure', async () => {
      const channel = createTestChannel();
      channel.shouldFailStart = true;

      await expect(channel.start()).rejects.toThrow('Start failed');
      expect(channel.status).toBe('error');
      expect(channel.doStartCalls).toBe(1);
    });

    it('should emit error event on start failure', async () => {
      const channel = createTestChannel();
      channel.shouldFailStart = true;
      const errorListener = vi.fn();
      channel.on('error', errorListener);

      await expect(channel.start()).rejects.toThrow();
      expect(errorListener).toHaveBeenCalledOnce();
    });

    it('should transition through starting state', async () => {
      const channel = createTestChannel();
      const statuses: string[] = [];

      // Use a slow start to capture intermediate state
      const originalDoStart = (channel as unknown as { doStart: () => Promise<void> }).doStart.bind(channel);
      (channel as unknown as { doStart: () => Promise<void> }).doStart = async () => {
        statuses.push(channel.status);
        await originalDoStart();
      };

      await channel.start();
      expect(statuses).toContain('starting');
      expect(channel.status).toBe('running');
    });
  });

  describe('stop', () => {
    it('should transition from running to stopped', async () => {
      const channel = createTestChannel();
      await channel.start();
      await channel.stop();
      expect(channel.status).toBe('stopped');
      expect(channel.doStopCalls).toBe(1);
    });

    it('should emit stopped event', async () => {
      const channel = createTestChannel();
      const listener = vi.fn();
      channel.on('stopped', listener);
      await channel.start();
      listener.mockClear();
      await channel.stop();
      expect(listener).toHaveBeenCalledOnce();
    });

    it('should be no-op when already stopped', async () => {
      const channel = createTestChannel();
      await channel.stop(); // stop without starting
      expect(channel.doStopCalls).toBe(0);
      expect(channel.status).toBe('stopped');
    });

    it('should transition to error state on stop failure', async () => {
      const channel = createTestChannel();
      await channel.start();
      channel.shouldFailStop = true;

      await expect(channel.stop()).rejects.toThrow('Stop failed');
      expect(channel.status).toBe('error');
    });
  });

  describe('sendMessage', () => {
    it('should delegate to doSendMessage when running', async () => {
      const channel = createTestChannel();
      await channel.start();

      const message: OutgoingMessage = {
        chatId: 'chat-1',
        type: 'text',
        text: 'Hello',
      };
      await channel.sendMessage(message);

      expect(channel.doSendMessageCalls).toHaveLength(1);
      expect(channel.doSendMessageCalls[0]).toEqual(message);
    });

    it('should throw when not running', async () => {
      const channel = createTestChannel();
      const message: OutgoingMessage = {
        chatId: 'chat-1',
        type: 'text',
        text: 'Hello',
      };

      await expect(channel.sendMessage(message)).rejects.toThrow('not running');
    });

    it('should throw when in error state', async () => {
      const channel = createTestChannel();
      channel.shouldFailStart = true;
      try { await channel.start(); } catch { /* expected */ }

      const message: OutgoingMessage = {
        chatId: 'chat-1',
        type: 'text',
        text: 'Hello',
      };

      await expect(channel.sendMessage(message)).rejects.toThrow('not running');
    });

    it('should propagate send errors', async () => {
      const channel = createTestChannel();
      await channel.start();
      channel.shouldFailSend = true;

      const message: OutgoingMessage = {
        chatId: 'chat-1',
        type: 'text',
        text: 'Hello',
      };

      await expect(channel.sendMessage(message)).rejects.toThrow('Send failed');
    });

    it('should throw when stopped', async () => {
      const channel = createTestChannel();
      await channel.start();
      await channel.stop();

      const message: OutgoingMessage = {
        chatId: 'chat-1',
        type: 'text',
        text: 'Hello',
      };

      await expect(channel.sendMessage(message)).rejects.toThrow('not running');
    });
  });

  describe('isHealthy', () => {
    it('should return true when running and healthy', async () => {
      const channel = createTestChannel();
      await channel.start();
      expect(channel.isHealthy()).toBe(true);
    });

    it('should return false when not running', () => {
      const channel = createTestChannel();
      expect(channel.isHealthy()).toBe(false);
    });

    it('should return false when running but unhealthy', async () => {
      const channel = createTestChannel();
      await channel.start();
      channel.healthy = false;
      expect(channel.isHealthy()).toBe(false);
    });

    it('should return false when in error state', async () => {
      const channel = createTestChannel();
      channel.shouldFailStart = true;
      try { await channel.start(); } catch { /* expected */ }
      expect(channel.isHealthy()).toBe(false);
    });
  });

  describe('onMessage', () => {
    it('should register a message handler', () => {
      const channel = createTestChannel();
      const handler: MessageHandler = vi.fn();
      channel.onMessage(handler);
      // Handler is registered — verified by emitMessage
    });
  });

  describe('onControl', () => {
    it('should register a control handler', () => {
      const channel = createTestChannel();
      const handler: ControlHandler = vi.fn();
      channel.onControl(handler);
      // Handler is registered
    });
  });

  describe('getCapabilities', () => {
    it('should return default capabilities', () => {
      const channel = createTestChannel();
      const caps = channel.getCapabilities();
      expect(caps).toBeDefined();
    });
  });

  // ==========================================================================
  // Issue #1617 Phase 2: emitMessage / emitControl coverage
  // ==========================================================================

  describe('emitMessage (protected)', () => {
    it('should delegate to registered message handler when set', async () => {
      const channel = createTestChannel();
      const handler: MessageHandler = vi.fn();
      channel.onMessage(handler);

      const message: IncomingMessage = {
        messageId: 'msg-1',
        chatId: 'chat-1',
        content: 'Hello',
        messageType: 'text',
      };
      await channel.testEmitMessage(message);
      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(message);
    });

    it('should not throw when no message handler is registered', async () => {
      const channel = createTestChannel();
      // No onMessage() call — handler is undefined

      const message: IncomingMessage = {
        messageId: 'msg-2',
        chatId: 'chat-1',
        content: 'Hello',
        messageType: 'text',
      };
      // Should log warning but not throw
      await expect(channel.testEmitMessage(message)).resolves.toBeUndefined();
    });
  });

  describe('emitControl (protected)', () => {
    it('should delegate to registered control handler when set', async () => {
      const channel = createTestChannel();
      const handler: ControlHandler = vi.fn().mockResolvedValue({ success: true, message: 'ok' });
      channel.onControl(handler);

      const command = { type: 'reset' as const, chatId: 'chat-1' };
      const result = await channel.testEmitControl(command);
      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(command);
      expect(result).toEqual({ success: true, message: 'ok' });
    });

    it('should return failure response when no control handler is registered', async () => {
      const channel = createTestChannel();
      // No onControl() call — handler is undefined

      const command = { type: 'status' as const, chatId: 'chat-1' };
      const result = await channel.testEmitControl(command);
      expect(result).toEqual({ success: false, error: 'No control handler registered' });
    });
  });

  describe('start - concurrent state transitions', () => {
    it('should be no-op when already in starting state', async () => {
      const channel = createTestChannel();
      // Simulate the starting state by using a slow doStart that still increments the counter
      let resolveStart: () => void;
      (channel as unknown as { doStart: () => Promise<void> }).doStart = () => {
        channel.doStartCalls++;
        return new Promise<void>((resolve) => { resolveStart = resolve; });
      };

      // First start — hangs in 'starting' state
      const startPromise = channel.start();
      expect(channel.status).toBe('starting');

      // Second start while starting — should be no-op (doStartCalls stays at 1)
      await channel.start();
      expect(channel.doStartCalls).toBe(1);

      // Complete the first start
      resolveStart!();
      await startPromise;
      expect(channel.status).toBe('running');
    });
  });

  describe('stop - concurrent state transitions', () => {
    it('should be no-op when already in stopping state', async () => {
      const channel = createTestChannel();
      await channel.start();

      // Simulate the stopping state by using a slow doStop that still increments the counter
      let resolveStop: () => void;
      (channel as unknown as { doStop: () => Promise<void> }).doStop = () => {
        channel.doStopCalls++;
        return new Promise<void>((resolve) => { resolveStop = resolve; });
      };

      // First stop — hangs in 'stopping' state
      const stopPromise = channel.stop();
      expect(channel.status).toBe('stopping');

      // Second stop while stopping — should be no-op (doStopCalls stays at 1)
      await channel.stop();
      expect(channel.doStopCalls).toBe(1);

      // Complete the first stop
      resolveStop!();
      await stopPromise;
      expect(channel.status).toBe('stopped');
    });
  });
});
