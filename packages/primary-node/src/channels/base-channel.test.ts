/**
 * Tests for BaseChannel module.
 *
 * Tests the base functionality that all channels inherit:
 * - State management
 * - Handler registration
 * - Lifecycle methods
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BaseChannel } from './base-channel.js';
import type {
  ChannelConfig,
  OutgoingMessage,
  IncomingMessage,
  ControlCommand,
  ControlResponse,
} from './types.js';

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  })),
}));

/**
 * Test implementation of BaseChannel for testing purposes.
 */
class TestChannel extends BaseChannel<ChannelConfig> {
  public doStartCalled = false;
  public doStopCalled = false;
  public doSendMessageCalled = false;
  public checkHealthResult = true;
  public lastMessage: OutgoingMessage | null = null;

  protected doStart(): Promise<void> {
    this.doStartCalled = true;
    return Promise.resolve();
  }

  protected doStop(): Promise<void> {
    this.doStopCalled = true;
    return Promise.resolve();
  }

  protected doSendMessage(message: OutgoingMessage): Promise<void> {
    this.doSendMessageCalled = true;
    this.lastMessage = message;
    return Promise.resolve();
  }

  protected checkHealth(): boolean {
    return this.checkHealthResult;
  }

  getCapabilities() {
    return {
      supportsCard: true,
      supportsThread: true,
      supportsFile: true,
      supportsMarkdown: true,
      supportsMention: true,
      supportsUpdate: true,
    };
  }

  // Expose protected methods for testing
  public testSetStatus(status: Parameters<BaseChannel['setStatus']>[0]): void {
    this.setStatus(status);
  }

  public testEmitMessage(message: IncomingMessage): Promise<void> {
    return this.emitMessage(message);
  }

  public testEmitControl(command: ControlCommand): Promise<ControlResponse> {
    return this.emitControl(command);
  }
}

describe('BaseChannel', () => {
  let channel: TestChannel;

  beforeEach(() => {
    vi.clearAllMocks();
    channel = new TestChannel({}, 'test-id', 'TestChannel');
  });

  afterEach(() => {
    channel.stop().catch(() => {});
  });

  describe('Constructor', () => {
    it('should create instance with default id', () => {
      expect(channel.id).toBe('test-id');
      expect(channel.name).toBe('TestChannel');
    });

    it('should use config id if provided', () => {
      const customChannel = new TestChannel({ id: 'custom-id' }, 'default-id', 'TestChannel');
      expect(customChannel.id).toBe('custom-id');
    });
  });

  describe('Status Management', () => {
    it('should start with stopped status', () => {
      expect(channel.status).toBe('stopped');
    });

    it('should transition status correctly on start', async () => {
      const statusChanges: string[] = [];
      channel.on('started', () => statusChanges.push('started'));

      await channel.start();

      expect(channel.status).toBe('running');
      expect(channel.doStartCalled).toBe(true);
      expect(statusChanges).toContain('started');
    });

    it('should transition status correctly on stop', async () => {
      await channel.start();
      const statusChanges: string[] = [];
      channel.on('stopped', () => statusChanges.push('stopped'));

      await channel.stop();

      expect(channel.status).toBe('stopped');
      expect(channel.doStopCalled).toBe(true);
      expect(statusChanges).toContain('stopped');
    });

    it('should not start if already running', async () => {
      await channel.start();
      channel.doStartCalled = false; // Reset

      await channel.start();

      expect(channel.doStartCalled).toBe(false);
    });

    it('should not stop if already stopped', async () => {
      channel.doStopCalled = false; // Reset

      await channel.stop();

      expect(channel.doStopCalled).toBe(false);
    });
  });

  describe('Handler Registration', () => {
    it('should register message handler', () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      channel.onMessage(handler);

      expect(channel['messageHandler']).toBe(handler);
    });

    it('should register control handler', () => {
      const handler = vi.fn().mockResolvedValue({ success: true });
      channel.onControl(handler);

      expect(channel['controlHandler']).toBe(handler);
    });
  });

  describe('sendMessage', () => {
    it('should send message when running', async () => {
      await channel.start();

      await channel.sendMessage({
        chatId: 'test-chat',
        type: 'text',
        text: 'Hello',
      });

      expect(channel.doSendMessageCalled).toBe(true);
      expect(channel.lastMessage).toEqual({
        chatId: 'test-chat',
        type: 'text',
        text: 'Hello',
      });
    });

    it('should throw error when not running', async () => {
      await expect(channel.sendMessage({
        chatId: 'test-chat',
        type: 'text',
        text: 'Hello',
      })).rejects.toThrow('is not running');
    });
  });

  describe('isHealthy', () => {
    it('should return true when running and health check passes', async () => {
      await channel.start();
      channel.checkHealthResult = true;

      expect(channel.isHealthy()).toBe(true);
    });

    it('should return false when not running', () => {
      channel.checkHealthResult = true;

      expect(channel.isHealthy()).toBe(false);
    });

    it('should return false when health check fails', async () => {
      await channel.start();
      channel.checkHealthResult = false;

      expect(channel.isHealthy()).toBe(false);
    });
  });

  describe('emitMessage (protected utility)', () => {
    it('should call registered message handler', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      channel.onMessage(handler);

      await channel.testEmitMessage({
        messageId: 'msg-1',
        chatId: 'chat-1',
        content: 'test',
        messageType: 'text',
      });

      expect(handler).toHaveBeenCalledWith({
        messageId: 'msg-1',
        chatId: 'chat-1',
        content: 'test',
        messageType: 'text',
      });
    });
  });

  describe('emitControl (protected utility)', () => {
    it('should call registered control handler', async () => {
      const handler = vi.fn().mockResolvedValue({ success: true, message: 'Done' });
      channel.onControl(handler);

      const response = await channel.testEmitControl({
        type: 'reset',
        chatId: 'chat-1',
      });

      expect(handler).toHaveBeenCalledWith({
        type: 'reset',
        chatId: 'chat-1',
      });
      expect(response).toEqual({ success: true, message: 'Done' });
    });

    it('should return error response when no handler registered', async () => {
      const response = await channel.testEmitControl({
        type: 'reset',
        chatId: 'chat-1',
      });

      expect(response.success).toBe(false);
      expect(response.error).toBe('No control handler registered');
    });
  });

  describe('Error Handling', () => {
    it('should emit error event on start failure', async () => {
      class FailingChannel extends BaseChannel<ChannelConfig> {
        protected doStart(): Promise<void> {
          return Promise.reject(new Error('Start failed'));
        }
        protected doStop(): Promise<void> { return Promise.resolve(); }
        protected doSendMessage(): Promise<void> { return Promise.resolve(); }
        protected checkHealth(): boolean { return true; }
        getCapabilities() { return { supportsCard: false, supportsThread: false, supportsFile: false, supportsMarkdown: true, supportsMention: false, supportsUpdate: false }; }
      }

      const failingChannel = new FailingChannel({}, 'fail', 'Fail');
      const errorHandler = vi.fn();
      failingChannel.on('error', errorHandler);

      await expect(failingChannel.start()).rejects.toThrow('Start failed');
      expect(errorHandler).toHaveBeenCalled();
      expect(failingChannel.status).toBe('error');
    });

    it('should emit error event on stop failure', async () => {
      class FailingStopChannel extends BaseChannel<ChannelConfig> {
        protected doStart(): Promise<void> { return Promise.resolve(); }
        protected doStop(): Promise<void> {
          return Promise.reject(new Error('Stop failed'));
        }
        protected doSendMessage(): Promise<void> { return Promise.resolve(); }
        protected checkHealth(): boolean { return true; }
        getCapabilities() { return { supportsCard: false, supportsThread: false, supportsFile: false, supportsMarkdown: true, supportsMention: false, supportsUpdate: false }; }
      }

      const failingChannel = new FailingStopChannel({}, 'fail', 'Fail');
      await failingChannel.start();

      const errorHandler = vi.fn();
      failingChannel.on('error', errorHandler);

      await expect(failingChannel.stop()).rejects.toThrow('Stop failed');
      expect(errorHandler).toHaveBeenCalled();
      expect(failingChannel.status).toBe('error');
    });
  });

  describe('Events', () => {
    it('should emit started event', async () => {
      const startedHandler = vi.fn();
      channel.on('started', startedHandler);

      await channel.start();

      expect(startedHandler).toHaveBeenCalled();
    });

    it('should emit stopped event', async () => {
      await channel.start();
      const stoppedHandler = vi.fn();
      channel.on('stopped', stoppedHandler);

      await channel.stop();

      expect(stoppedHandler).toHaveBeenCalled();
    });
  });
});
