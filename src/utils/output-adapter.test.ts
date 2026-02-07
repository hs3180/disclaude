/**
 * Tests for Output Adapter (src/utils/output-adapter.ts)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CLIOutputAdapter,
  FeishuOutputAdapter,
  type OutputAdapter,
  type FeishuOutputAdapterOptions,
} from './output-adapter.js';

describe('Output Adapter', () => {
  describe('CLIOutputAdapter', () => {
    const originalStdoutWrite = process.stdout.write;
    const originalConsoleLog = console.log;

    beforeEach(() => {
      process.stdout.write = vi.fn();
      console.log = vi.fn();
    });

    afterEach(() => {
      process.stdout.write = originalStdoutWrite;
      console.log = originalConsoleLog;
      vi.clearAllMocks();
    });

    it('should write text messages without extra newline', () => {
      const adapter = new CLIOutputAdapter();
      adapter.write('Hello, world!', 'text');

      expect(process.stdout.write).toHaveBeenCalled();
      expect(console.log).not.toHaveBeenCalled();
    });

    it('should add newline for non-text messages', () => {
      const adapter = new CLIOutputAdapter();
      adapter.write('Tool started', 'tool_use');

      expect(console.log).toHaveBeenCalled();
    });

    it('should add blank line when message type changes', () => {
      const adapter = new CLIOutputAdapter();
      adapter.write('Text message', 'text');
      adapter.write('Tool started', 'tool_use');

      expect(console.log).toHaveBeenCalledTimes(2); // One for blank line, one for message
    });

    it('should finalize with newline', () => {
      const adapter = new CLIOutputAdapter();
      adapter.write('Final message', 'text');
      adapter.finalize();

      expect(console.log).toHaveBeenCalled();
    });

    it('should handle all message types', () => {
      const adapter = new CLIOutputAdapter();

      const messageTypes = [
        'text',
        'tool_use',
        'tool_progress',
        'tool_result',
        'error',
        'status',
        'result',
        'notification',
      ] as const;

      messageTypes.forEach(type => {
        adapter.write(`Message of type ${type}`, type);
      });

      expect(process.stdout.write).toHaveBeenCalledTimes(messageTypes.length);
    });
  });

  describe('FeishuOutputAdapter', () => {
    let mockSendMessage: ReturnType<typeof vi.fn>;
    let mockSendCard: ReturnType<typeof vi.fn>;
    let adapter: FeishuOutputAdapter;

    beforeEach(() => {
      mockSendMessage = vi.fn().mockResolvedValue(undefined);
      mockSendCard = vi.fn().mockResolvedValue(undefined);

      const options: FeishuOutputAdapterOptions = {
        sendMessage: mockSendMessage,
        sendCard: mockSendCard,
        chatId: 'test-chat-id',
        throttleIntervalMs: 1000,
      };

      adapter = new FeishuOutputAdapter(options);
    });

    it('should create instance with options', () => {
      expect(adapter).toBeInstanceOf(FeishuOutputAdapter);
    });

    it('should send text message', async () => {
      await adapter.write('Hello, Feishu!', 'text');

      expect(mockSendMessage).toHaveBeenCalledWith('test-chat-id', 'Hello, Feishu!');
    });

    it('should skip empty content', async () => {
      await adapter.write('   ', 'text');
      await adapter.write('', 'text');

      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('should skip SDK completion messages', async () => {
      await adapter.write('✅ Complete', 'result');

      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('should throttle progress messages', async () => {
      // First message should send
      await adapter.write('Using Bash: running command', 'tool_progress');
      expect(mockSendMessage).toHaveBeenCalledTimes(1);

      // Immediate second message should be throttled
      await adapter.write('Using Bash: still running', 'tool_progress');
      expect(mockSendMessage).toHaveBeenCalledTimes(1);

      // Wait for throttle interval
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Third message should send after throttle period
      await adapter.write('Using Bash: completed', 'tool_progress');
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
    });

    it('should track message sent status', async () => {
      expect(adapter.hasSentMessage()).toBe(false);

      await adapter.write('First message', 'text');

      expect(adapter.hasSentMessage()).toBe(true);
    });

    it('should reset message tracking', async () => {
      await adapter.write('First message', 'text');
      expect(adapter.hasSentMessage()).toBe(true);

      adapter.resetMessageTracking();
      expect(adapter.hasSentMessage()).toBe(false);
    });

    it('should clear throttle state', async () => {
      await adapter.write('Using Bash: first', 'tool_progress');
      await adapter.write('Using Bash: second', 'tool_progress');

      expect(mockSendMessage).toHaveBeenCalledTimes(1);

      adapter.clearThrottleState();

      // After clearing, next progress message should send
      await adapter.write('Using Bash: third', 'tool_progress');
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
    });

    it('should use default throttle interval when not specified', () => {
      const options: FeishuOutputAdapterOptions = {
        sendMessage: mockSendMessage,
        sendCard: mockSendCard,
        chatId: 'test-chat-id',
      };

      const adapterNoThrottle = new FeishuOutputAdapter(options);

      expect(adapterNoThrottle).toBeInstanceOf(FeishuOutputAdapter);
    });

    it('should handle different message types', async () => {
      await adapter.write('Error occurred', 'error');
      expect(mockSendMessage).toHaveBeenCalledWith('test-chat-id', 'Error occurred');

      vi.clearAllMocks();

      await adapter.write('Status update', 'status');
      expect(mockSendMessage).toHaveBeenCalledWith('test-chat-id', 'Status update');
    });

    it('should handle file attachment config', () => {
      const options: FeishuOutputAdapterOptions = {
        sendMessage: mockSendMessage,
        sendCard: mockSendCard,
        chatId: 'test-chat-id',
        fileAttachment: {
          minLines: 1000,
          minChars: 20000,
          patterns: ['*.log', '*.txt'],
        },
      };

      const adapterWithConfig = new FeishuOutputAdapter(options);

      expect(adapterWithConfig).toBeInstanceOf(FeishuOutputAdapter);
    });
  });

  describe('OutputAdapter Interface', () => {
    it('should allow custom implementation', async () => {
      const customAdapter: OutputAdapter = {
        write: vi.fn().mockResolvedValue(undefined),
      };

      await customAdapter.write('Test message', 'text');

      expect(customAdapter.write).toHaveBeenCalledWith('Test message', 'text');
    });
  });
});
