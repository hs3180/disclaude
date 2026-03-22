/**
 * Unit tests for ContextCompressor (Issue #1311).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextCompressor } from './context-compressor.js';
import type pino from 'pino';

// Create mock logger
function createMockLogger(): pino.Logger {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'info',
    bindings: vi.fn().mockReturnValue({}),
    flush: vi.fn(),
  } as unknown as pino.Logger;
}

// Sample history in the expected format
const SAMPLE_HISTORY = `👤 [2024-01-15 10:00:00] (msg-001)
Hello, can you help me with a coding problem?

---

🤖 [2024-01-15 10:00:05] (msg-002)
Of course! I'd be happy to help. What's the problem?

---

👤 [2024-01-15 10:01:00] (msg-003)
I need to implement a binary search in Python.

---

🤖 [2024-01-15 10:01:30] (msg-004)
Sure! Here's a basic implementation...

---

👤 [2024-01-15 10:05:00] (msg-005)
That works perfectly, thanks!

---

🤖 [2024-01-15 10:05:10] (msg-006)
You're welcome! Let me know if you need anything else.`;

describe('ContextCompressor', () => {
  let compressor: ContextCompressor;
  let mockLogger: pino.Logger;

  beforeEach(() => {
    mockLogger = createMockLogger();
    compressor = new ContextCompressor({ enabled: true }, mockLogger);
  });

  describe('constructor', () => {
    it('should apply default values for missing config', () => {
      const c = new ContextCompressor({}, mockLogger);
      const config = c.getConfig();

      expect(config.enabled).toBe(false); // default is disabled
      expect(config.threshold).toBe(3000);
      expect(config.keepRecentMessages).toBe(4);
      expect(config.summaryMaxTokens).toBe(500);
    });

    it('should use provided config values', () => {
      const c = new ContextCompressor({
        enabled: true,
        threshold: 5000,
        keepRecentMessages: 6,
        summaryMaxTokens: 1000,
      }, mockLogger);
      const config = c.getConfig();

      expect(config.enabled).toBe(true);
      expect(config.threshold).toBe(5000);
      expect(config.keepRecentMessages).toBe(6);
      expect(config.summaryMaxTokens).toBe(1000);
    });
  });

  describe('isEnabled', () => {
    it('should return false when disabled', () => {
      const c = new ContextCompressor({ enabled: false }, mockLogger);
      expect(c.isEnabled()).toBe(false);
    });

    it('should return true when enabled', () => {
      expect(compressor.isEnabled()).toBe(true);
    });

    it('should default to false', () => {
      const c = new ContextCompressor({}, mockLogger);
      expect(c.isEnabled()).toBe(false);
    });
  });

  describe('compress', () => {
    it('should return original content when disabled', async () => {
      const c = new ContextCompressor({ enabled: false, threshold: 100 }, mockLogger);
      const result = await c.compress(SAMPLE_HISTORY, vi.fn());

      expect(result.compressed).toBe(false);
      expect(result.content).toBe(SAMPLE_HISTORY);
      expect(result.originalLength).toBe(SAMPLE_HISTORY.length);
      expect(result.compressedLength).toBe(SAMPLE_HISTORY.length);
      expect(result.summaryLength).toBe(0);
    });

    it('should return original content when below threshold', async () => {
      const c = new ContextCompressor({ enabled: true, threshold: 100000 }, mockLogger);
      const result = await c.compress(SAMPLE_HISTORY, vi.fn());

      expect(result.compressed).toBe(false);
      expect(result.content).toBe(SAMPLE_HISTORY);
    });

    it('should compress when history exceeds threshold', async () => {
      const c = new ContextCompressor({
        enabled: true,
        threshold: 100,
        keepRecentMessages: 2,
      }, mockLogger);

      const mockSummary = 'User asked about implementing binary search in Python. The assistant provided a working solution that the user confirmed works.';
      const summarizeFn = vi.fn().mockResolvedValue(mockSummary);

      const result = await c.compress(SAMPLE_HISTORY, summarizeFn);

      expect(result.compressed).toBe(true);
      expect(result.summaryLength).toBe(mockSummary.length);
      expect(summarizeFn).toHaveBeenCalledOnce();
      expect(result.content).toContain('Earlier Conversation Summary');
      expect(result.content).toContain(mockSummary);
      expect(result.content).toContain('Recent Messages');
    });

    it('should keep recent messages intact in compressed output', async () => {
      const c = new ContextCompressor({
        enabled: true,
        threshold: 100,
        keepRecentMessages: 2,
      }, mockLogger);

      const mockSummary = 'Summary of earlier conversation.';
      const summarizeFn = vi.fn().mockResolvedValue(mockSummary);

      const result = await c.compress(SAMPLE_HISTORY, summarizeFn);

      // The last 2 messages should be kept intact in the Recent Messages section
      expect(result.content).toContain('msg-005');
      expect(result.content).toContain('msg-006');
      // Earlier messages (msg-001 to msg-004) should NOT appear as raw text in output
      // They are summarized by AI and replaced with the mock summary
      expect(result.content).not.toContain('msg-001');
      expect(result.content).not.toContain('msg-004');
    });

    it('should call summarizeFn with the older messages', async () => {
      // keepRecentMessages: 2 means first 4 of 6 messages go to summarization
      const c = new ContextCompressor({
        enabled: true,
        threshold: 100,
        keepRecentMessages: 2,
      }, mockLogger);

      const summarizeFn = vi.fn().mockResolvedValue('Summary');

      await c.compress(SAMPLE_HISTORY, summarizeFn);

      // The prompt should contain the first 4 messages (msg-001 to msg-004)
      // and NOT the last 2 (msg-005, msg-006)
      const callArg = summarizeFn.mock.calls[0][0];
      expect(callArg).toContain('msg-001');
      expect(callArg).toContain('msg-002');
      expect(callArg).toContain('msg-003');
      expect(callArg).toContain('msg-004');
      expect(callArg).not.toContain('msg-005');
      expect(callArg).not.toContain('msg-006');
    });

    it('should fallback to truncation when summarization fails', async () => {
      const c = new ContextCompressor({
        enabled: true,
        threshold: 100,
        keepRecentMessages: 2,
      }, mockLogger);

      const summarizeFn = vi.fn().mockRejectedValue(new Error('API error'));

      const result = await c.compress(SAMPLE_HISTORY, summarizeFn);

      expect(result.compressed).toBe(true);
      expect(result.summaryLength).toBe(0);
      // Should fall back to truncation (slice from end)
      expect(result.compressedLength).toBeLessThan(result.originalLength);
      expect(result.content.length).toBe(100);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'Context compression failed, falling back to truncation'
      );
    });

    it('should fallback to truncation when not enough messages to split', async () => {
      // History with only 1 message
      const shortHistory = `👤 [2024-01-15 10:00:00] (msg-001)
Hello!

---`;

      const c = new ContextCompressor({
        enabled: true,
        threshold: 10, // Very low threshold
        keepRecentMessages: 4, // More than available
      }, mockLogger);

      const summarizeFn = vi.fn().mockResolvedValue('Summary');

      const result = await c.compress(shortHistory, summarizeFn);

      expect(result.compressed).toBe(true);
      expect(result.summaryLength).toBe(0);
      expect(summarizeFn).not.toHaveBeenCalled();
    });

    it('should update stats after compression', async () => {
      const c = new ContextCompressor({
        enabled: true,
        threshold: 100,
        keepRecentMessages: 2,
      }, mockLogger);

      const summarizeFn = vi.fn().mockResolvedValue('Brief summary');

      await c.compress(SAMPLE_HISTORY, summarizeFn);

      const stats = c.getStats();
      expect(stats.totalCompressions).toBe(1);
      expect(stats.totalCharsSaved).toBeGreaterThan(0);
      expect(stats.lastCompressedAt).toBeDefined();
      expect(stats.lastCompressedAt).toBeGreaterThan(0);
    });
  });

  describe('splitIntoMessages', () => {
    it('should split history by --- separator', () => {
      const messages = compressor.splitIntoMessages(SAMPLE_HISTORY);

      // Should split into 6 messages (3 user + 3 assistant)
      expect(messages).toHaveLength(6);
    });

    it('should preserve message content', () => {
      const messages = compressor.splitIntoMessages(SAMPLE_HISTORY);

      // First message should contain user greeting
      expect(messages[0].content).toContain('Hello, can you help me');
      // Last message should contain assistant closing
      expect(messages[messages.length - 1].content).toContain("You're welcome!");
    });

    it('should handle empty input', () => {
      const messages = compressor.splitIntoMessages('');
      expect(messages).toHaveLength(0);
    });

    it('should handle single message', () => {
      const singleMessage = '👤 [2024-01-15 10:00:00] (msg-001)\nHello!';
      const messages = compressor.splitIntoMessages(singleMessage);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe(singleMessage);
    });

    it('should set correct start and end indices', () => {
      const messages = compressor.splitIntoMessages(SAMPLE_HISTORY);

      expect(messages[0].start).toBe(0);
      // Each message should have end > start
      for (const msg of messages) {
        expect(msg.end).toBeGreaterThan(msg.start);
      }
      // Messages should be in order
      for (let i = 1; i < messages.length; i++) {
        expect(messages[i].start).toBeGreaterThan(messages[i - 1].start);
      }
    });

    it('should skip empty segments', () => {
      const historyWithEmpty = `👤 [2024-01-15 10:00:00] (msg-001)
Hello

---

---

🤖 [2024-01-15 10:00:05] (msg-002)
Hi!`;

      const messages = compressor.splitIntoMessages(historyWithEmpty);
      expect(messages).toHaveLength(2);
    });
  });

  describe('getStats', () => {
    it('should return initial stats', () => {
      const stats = compressor.getStats();

      expect(stats.totalCompressions).toBe(0);
      expect(stats.totalCharsSaved).toBe(0);
      expect(stats.lastCompressedAt).toBeUndefined();
    });
  });

  describe('integration: compression format', () => {
    it('should produce well-formatted compressed output', async () => {
      const c = new ContextCompressor({
        enabled: true,
        threshold: 100,
        keepRecentMessages: 2,
      }, mockLogger);

      const mockSummary = 'The user asked about binary search in Python and got a working solution.';
      const summarizeFn = vi.fn().mockResolvedValue(mockSummary);

      const result = await c.compress(SAMPLE_HISTORY, summarizeFn);

      // Check format
      expect(result.content).toContain('## 📋 Earlier Conversation Summary');
      expect(result.content).toContain('## 💬 Recent Messages');
      expect(result.content).toContain('---');

      // Summary should appear before recent messages
      const summaryIndex = result.content.indexOf(mockSummary);
      const recentIndex = result.content.indexOf('## 💬 Recent Messages');
      expect(summaryIndex).toBeLessThan(recentIndex);
    });
  });
});
