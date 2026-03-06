/**
 * Tests for TTFR Metrics Module.
 *
 * Tests the Time to First Response metrics tracking:
 * - Start tracking when user message is received
 * - Record response and calculate TTFR
 * - Statistics calculation (avg, p50, p90, p99)
 * - Rating system
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TTFRMetricsManager } from './ttfr-metrics.js';

// Mock logger
vi.mock('./logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

describe('TTFRMetricsManager', () => {
  let metrics: TTFRMetricsManager;

  beforeEach(() => {
    metrics = new TTFRMetricsManager(100);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('startTracking', () => {
    it('should start tracking for a chat', () => {
      metrics.startTracking('chat_123', 'msg_456');

      const status = metrics.getTrackingStatus();
      expect(status.pendingCount).toBe(1);
    });

    it('should replace existing tracking for same chat', () => {
      metrics.startTracking('chat_123', 'msg_1');
      metrics.startTracking('chat_123', 'msg_2');

      const status = metrics.getTrackingStatus();
      expect(status.pendingCount).toBe(1);
    });
  });

  describe('recordResponse', () => {
    it('should record TTFR when first response is sent', () => {
      metrics.startTracking('chat_123', 'msg_456');
      vi.advanceTimersByTime(1000);

      const record = metrics.recordResponse('chat_123', 'bot_msg_789');

      expect(record).not.toBeNull();
      expect(record?.ttfrMs).toBe(1000);
      expect(record?.userMessageId).toBe('msg_456');
      expect(record?.chatId).toBe('chat_123');
    });

    it('should return null if no tracking started', () => {
      const record = metrics.recordResponse('chat_123', 'bot_msg_789');
      expect(record).toBeNull();
    });

    it('should only record first response', () => {
      metrics.startTracking('chat_123', 'msg_456');
      vi.advanceTimersByTime(1000);

      const first = metrics.recordResponse('chat_123', 'bot_msg_1');
      const second = metrics.recordResponse('chat_123', 'bot_msg_2');

      expect(first).not.toBeNull();
      expect(first?.ttfrMs).toBe(1000);
      expect(second).toBeNull();
    });

    it('should include model if provided', () => {
      metrics.startTracking('chat_123', 'msg_456');
      vi.advanceTimersByTime(500);

      const record = metrics.recordResponse('chat_123', 'bot_msg_789', 'claude-sonnet-4');

      expect(record?.model).toBe('claude-sonnet-4');
    });
  });

  describe('clearTracking', () => {
    it('should clear tracking for a chat', () => {
      metrics.startTracking('chat_123', 'msg_456');
      metrics.clearTracking('chat_123');

      const record = metrics.recordResponse('chat_123', 'bot_msg_789');
      expect(record).toBeNull();
    });
  });

  describe('getRecords', () => {
    it('should return all records', () => {
      metrics.startTracking('chat_1', 'msg_1');
      vi.advanceTimersByTime(100);
      metrics.recordResponse('chat_1', 'bot_1');

      metrics.startTracking('chat_2', 'msg_2');
      vi.advanceTimersByTime(200);
      metrics.recordResponse('chat_2', 'bot_2');

      const records = metrics.getRecords();
      expect(records.length).toBe(2);
    });

    it('should filter records by chatId', () => {
      metrics.startTracking('chat_1', 'msg_1');
      vi.advanceTimersByTime(100);
      metrics.recordResponse('chat_1', 'bot_1');

      metrics.startTracking('chat_2', 'msg_2');
      vi.advanceTimersByTime(200);
      metrics.recordResponse('chat_2', 'bot_2');

      const records = metrics.getRecords('chat_1');
      expect(records.length).toBe(1);
      expect(records[0].chatId).toBe('chat_1');
    });
  });

  describe('getStats', () => {
    it('should return null if no records', () => {
      const stats = metrics.getStats();
      expect(stats).toBeNull();
    });

    it('should calculate statistics correctly', () => {
      // Add some records
      const ttfrs = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];

      ttfrs.forEach((ttfr, i) => {
        metrics.startTracking(`chat_${i}`, `msg_${i}`);
        vi.advanceTimersByTime(ttfr);
        metrics.recordResponse(`chat_${i}`, `bot_${i}`);
      });

      const stats = metrics.getStats();

      expect(stats).not.toBeNull();
      expect(stats?.count).toBe(10);
      expect(stats?.minMs).toBe(100);
      expect(stats?.maxMs).toBe(1000);
      expect(stats?.avgMs).toBe(550);
    });

    it('should filter stats by chatId', () => {
      metrics.startTracking('chat_1', 'msg_1');
      vi.advanceTimersByTime(100);
      metrics.recordResponse('chat_1', 'bot_1');

      metrics.startTracking('chat_2', 'msg_2');
      vi.advanceTimersByTime(200);
      metrics.recordResponse('chat_2', 'bot_2');

      const stats = metrics.getStats('chat_1');

      expect(stats?.count).toBe(1);
      expect(stats?.avgMs).toBe(100);
    });
  });

  describe('getTTFRRating', () => {
    it('should return excellent for < 3s', () => {
      expect(metrics.getTTFRRating(500)).toBe('excellent');
      expect(metrics.getTTFRRating(2999)).toBe('excellent');
    });

    it('should return good for < 5s', () => {
      expect(metrics.getTTFRRating(3000)).toBe('good');
      expect(metrics.getTTFRRating(4999)).toBe('good');
    });

    it('should return acceptable for < 10s', () => {
      expect(metrics.getTTFRRating(5000)).toBe('acceptable');
      expect(metrics.getTTFRRating(9999)).toBe('acceptable');
    });

    it('should return needs_improvement for >= 10s', () => {
      expect(metrics.getTTFRRating(10000)).toBe('needs_improvement');
      expect(metrics.getTTFRRating(15000)).toBe('needs_improvement');
    });
  });

  describe('maxRecords limit', () => {
    it('should limit records to maxRecords', () => {
      const smallMetrics = new TTFRMetricsManager(5);

      for (let i = 0; i < 10; i++) {
        smallMetrics.startTracking(`chat_${i}`, `msg_${i}`);
        vi.advanceTimersByTime(100);
        smallMetrics.recordResponse(`chat_${i}`, `bot_${i}`);
      }

      const records = smallMetrics.getRecords();
      expect(records.length).toBe(5);
    });
  });

  describe('clearAll', () => {
    it('should clear all records and tracking', () => {
      metrics.startTracking('chat_1', 'msg_1');
      vi.advanceTimersByTime(100);
      metrics.recordResponse('chat_1', 'bot_1');

      metrics.clearAll();

      expect(metrics.getRecords().length).toBe(0);
      expect(metrics.getTrackingStatus().pendingCount).toBe(0);
    });
  });
});

// Import afterEach for cleanup
import { afterEach } from 'vitest';
