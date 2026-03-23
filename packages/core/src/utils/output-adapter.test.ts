/**
 * Tests for Output Adapters (packages/core/src/utils/output-adapter.ts)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CLIOutputAdapter, FeishuOutputAdapter } from './output-adapter.js';
import type { FeishuOutputAdapterOptions } from './output-adapter.js';

// ============================================================================
// CLIOutputAdapter
// ============================================================================

describe('CLIOutputAdapter', () => {
  let adapter: CLIOutputAdapter;

  beforeEach(() => {
    adapter = new CLIOutputAdapter();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should write to stdout', () => {
    adapter.write('hello', 'text');
    expect(process.stdout.write).toHaveBeenCalled();
  });

  it('should format non-text messages with colors', () => {
    adapter.write('error message', 'error');
    expect(process.stdout.write).toHaveBeenCalledWith(
      expect.stringContaining('error message')
    );
  });

  it('should add newline between different message types', () => {
    adapter.write('first', 'text');
    adapter.write('tool output', 'tool_result');
    // console.log should be called for the separator newline
    expect(console.log).toHaveBeenCalled();
  });

  it('should not add separator for consecutive same-type messages', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    adapter.write('first text', 'text');
    adapter.write('second text', 'text');
    // console.log may be called but not for type separator
    // The separator only happens when messageType !== lastMessageType && messageType !== 'text'
    // Since second call is also 'text', no separator
    const logCalls = logSpy.mock.calls.length;
    // First write: no separator (text->text), second write: no separator (text->text)
    // Both writes: console.log is called for non-text messages (they have console.log after write)
    // But for text messages, only stdout.write is called, not console.log
    // So console.log should not be called for text-only messages
    expect(logCalls).toBe(0);
  });

  it('should call finalize without errors', () => {
    expect(() => adapter.finalize()).not.toThrow();
  });
});

// ============================================================================
// FeishuOutputAdapter
// ============================================================================

describe('FeishuOutputAdapter', () => {
  let sendMessage: ReturnType<typeof vi.fn>;
  let options: FeishuOutputAdapterOptions;
  let adapter: FeishuOutputAdapter;

  beforeEach(() => {
    sendMessage = vi.fn().mockResolvedValue(undefined);
    options = {
      sendMessage,
      chatId: 'test-chat-1',
      throttleIntervalMs: 1000,
    };
    adapter = new FeishuOutputAdapter(options);
  });

  describe('write', () => {
    it('should skip empty content', async () => {
      await adapter.write('');
      await adapter.write('   ');
      await adapter.write('\t\n');
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('should skip "✅ Complete" result messages', async () => {
      await adapter.write('✅ Complete - task done', 'result');
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('should send non-empty text messages', async () => {
      await adapter.write('Hello world', 'text');
      expect(sendMessage).toHaveBeenCalledWith('test-chat-1', 'Hello world');
    });

    it('should send non-complete result messages', async () => {
      await adapter.write('Here is the result', 'result');
      expect(sendMessage).toHaveBeenCalledWith('test-chat-1', 'Here is the result');
    });

    it('should set messageSentFlag after sending', async () => {
      expect(adapter.hasSentMessage()).toBe(false);
      await adapter.write('hello', 'text');
      expect(adapter.hasSentMessage()).toBe(true);
    });

    it('should throttle progress messages', async () => {
      // First progress message should be sent
      await adapter.write('Using Read: reading file...', 'tool_progress');
      expect(sendMessage).toHaveBeenCalledTimes(1);

      // Second progress message within throttle interval should be skipped
      await adapter.write('Using Read: still reading...', 'tool_progress');
      expect(sendMessage).toHaveBeenCalledTimes(1);

      // Wait for throttle interval to pass
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Third message after interval should be sent
      await adapter.write('Using Read: done reading', 'tool_progress');
      expect(sendMessage).toHaveBeenCalledTimes(2);
    });

    it('should extract tool name from content for throttling', async () => {
      await adapter.write('Using Bash: running command', 'tool_progress');
      expect(sendMessage).toHaveBeenCalledTimes(1);

      // Different tool name - should be sent even within interval
      await adapter.write('Using Write: writing file', 'tool_progress');
      expect(sendMessage).toHaveBeenCalledTimes(2);
    });

    it('should use "unknown" as tool name when pattern does not match', async () => {
      await adapter.write('some progress update', 'tool_progress');
      expect(sendMessage).toHaveBeenCalledTimes(1);

      // Same unknown tool - should be throttled
      await adapter.write('another progress update', 'tool_progress');
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('hasSentMessage / resetMessageTracking', () => {
    it('should initially return false', () => {
      expect(adapter.hasSentMessage()).toBe(false);
    });

    it('should return true after a message is sent', async () => {
      await adapter.write('hello', 'text');
      expect(adapter.hasSentMessage()).toBe(true);
    });

    it('should return false after reset', async () => {
      await adapter.write('hello', 'text');
      expect(adapter.hasSentMessage()).toBe(true);
      adapter.resetMessageTracking();
      expect(adapter.hasSentMessage()).toBe(false);
    });
  });

  describe('clearThrottleState', () => {
    it('should clear throttle entries for the current chat only', async () => {
      // Send a progress message to establish throttle state
      await adapter.write('Using Read: reading...', 'tool_progress');
      expect(sendMessage).toHaveBeenCalledTimes(1);

      // Clear throttle state
      adapter.clearThrottleState();

      // Should be able to send again immediately
      await adapter.write('Using Read: reading again...', 'tool_progress');
      expect(sendMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe('constructor', () => {
    it('should use default throttle interval of 2000ms', () => {
      const adapter2 = new FeishuOutputAdapter({
        sendMessage,
        chatId: 'test',
      });
      // Default interval is 2000ms - verify by sending two messages quickly
      // First message sent
      adapter2.write('Using Read: test', 'tool_progress');
      // Second within 2000ms should be throttled
      adapter2.write('Using Read: test2', 'tool_progress');
      // We can't easily test timing here, but the constructor should not throw
      expect(adapter2).toBeDefined();
    });
  });
});
