/**
 * Tests for TTFR Tracker.
 *
 * @module metrics/ttfr-tracker.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TTFRTracker,
  getTTFRTracker,
  getTTFRRating,
  TTFR_RATINGS,
} from './ttfr-tracker.js';

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => '[]'),
  writeFileSync: vi.fn(),
}));

describe('TTFRTracker', () => {
  let tracker: TTFRTracker;

  beforeEach(() => {
    vi.clearAllMocks();
    tracker = new TTFRTracker('/tmp/test-ttfr');
  });

  afterEach(() => {
    tracker.clear();
  });

  describe('recordUserMessage', () => {
    it('should record a user message', () => {
      tracker.recordUserMessage('chat1', 'msg1', 1000);
      expect(tracker.getPendingCount()).toBe(1);
    });

    it('should record multiple user messages', () => {
      tracker.recordUserMessage('chat1', 'msg1', 1000);
      tracker.recordUserMessage('chat1', 'msg2', 2000);
      tracker.recordUserMessage('chat2', 'msg3', 3000);
      expect(tracker.getPendingCount()).toBe(3);
    });
  });

  describe('recordFirstResponse', () => {
    it('should calculate TTFR when response is recorded', async () => {
      tracker.recordUserMessage('chat1', 'msg1', 1000);

      // Mock Date.now to return a fixed time
      const originalDateNow = Date.now;
      Date.now = () => 3000;

      const result = await tracker.recordFirstResponse('chat1');

      Date.now = originalDateNow;

      expect(result).toBeDefined();
      expect(result?.ttfrMs).toBe(2000);
      expect(result?.userMessageId).toBe('msg1');
    });

    it('should remove pending message after response', async () => {
      tracker.recordUserMessage('chat1', 'msg1', 1000);
      await tracker.recordFirstResponse('chat1');
      expect(tracker.getPendingCount()).toBe(0);
    });

    it('should return undefined when no pending message', async () => {
      const result = await tracker.recordFirstResponse('unknown-chat');
      expect(result).toBeUndefined();
    });

    it('should use the most recent pending message', async () => {
      tracker.recordUserMessage('chat1', 'msg1', 1000);
      tracker.recordUserMessage('chat1', 'msg2', 2000);

      const originalDateNow = Date.now;
      Date.now = () => 5000;

      const result = await tracker.recordFirstResponse('chat1');

      Date.now = originalDateNow;

      expect(result?.userMessageId).toBe('msg2');
      expect(result?.ttfrMs).toBe(3000);
    });
  });

  describe('getRecords', () => {
    it('should return empty array initially', async () => {
      await tracker.init();
      expect(tracker.getRecords()).toHaveLength(0);
    });

    it('should return recorded TTFR records', async () => {
      await tracker.init();
      tracker.recordUserMessage('chat1', 'msg1', 1000);

      const originalDateNow = Date.now;
      Date.now = () => 3000;
      await tracker.recordFirstResponse('chat1');
      Date.now = originalDateNow;

      const records = tracker.getRecords();
      expect(records).toHaveLength(1);
      expect(records[0].chatId).toBe('chat1');
      expect(records[0].ttfrMs).toBe(2000);
    });
  });

  describe('getRecordsFiltered', () => {
    beforeEach(async () => {
      await tracker.init();
      tracker.clear();

      // Add some test records
      tracker.recordUserMessage('chat1', 'msg1', 1000);
      const originalDateNow = Date.now;
      Date.now = () => 3000;
      await tracker.recordFirstResponse('chat1');
      Date.now = originalDateNow;

      tracker.recordUserMessage('chat2', 'msg2', 5000);
      Date.now = () => 7000;
      await tracker.recordFirstResponse('chat2');
      Date.now = originalDateNow;
    });

    it('should filter by chatId', () => {
      const records = tracker.getRecordsFiltered({ chatId: 'chat1' });
      expect(records).toHaveLength(1);
      expect(records[0].chatId).toBe('chat1');
    });

    it('should filter by startTime', () => {
      const records = tracker.getRecordsFiltered({ startTime: 4000 });
      expect(records).toHaveLength(1);
      expect(records[0].chatId).toBe('chat2');
    });

    it('should filter by endTime', () => {
      const records = tracker.getRecordsFiltered({ endTime: 2000 });
      expect(records).toHaveLength(1);
      expect(records[0].chatId).toBe('chat1');
    });

    it('should limit results', () => {
      const records = tracker.getRecordsFiltered({ limit: 1 });
      expect(records).toHaveLength(1);
    });
  });

  describe('calculateStats', () => {
    it('should return null for empty records', () => {
      const stats = tracker.calculateStats([]);
      expect(stats).toBeNull();
    });

    it('should calculate correct statistics', async () => {
      await tracker.init();
      tracker.clear();

      // Create records with known TTFR values
      const baseTime = 10000;
      const ttfrs = [1000, 2000, 3000, 4000, 5000];

      for (let i = 0; i < ttfrs.length; i++) {
        tracker.recordUserMessage('chat1', `msg${i}`, baseTime + i * 10000);
        const originalDateNow = Date.now;
        Date.now = () => baseTime + i * 10000 + ttfrs[i];
        await tracker.recordFirstResponse('chat1');
        Date.now = originalDateNow;
      }

      const records = tracker.getRecords();
      const stats = tracker.calculateStats(records);

      expect(stats).not.toBeNull();
      expect(stats!.count).toBe(5);
      expect(stats!.minMs).toBe(1000);
      expect(stats!.maxMs).toBe(5000);
      expect(stats!.avgMs).toBe(3000);
      expect(stats!.p50Ms).toBe(3000);
    });
  });

  describe('getStatsForChat', () => {
    it('should return stats for specific chat', async () => {
      await tracker.init();
      tracker.clear();

      tracker.recordUserMessage('chat1', 'msg1', 1000);
      const originalDateNow = Date.now;
      Date.now = () => 3000;
      await tracker.recordFirstResponse('chat1');
      Date.now = originalDateNow;

      const stats = tracker.getStatsForChat('chat1');
      expect(stats).not.toBeNull();
      expect(stats!.count).toBe(1);
    });

    it('should return null for unknown chat', () => {
      const stats = tracker.getStatsForChat('unknown-chat');
      expect(stats).toBeNull();
    });
  });
});

describe('getTTFRRating', () => {
  it('should return EXCELLENT for < 3s', () => {
    const rating = getTTFRRating(2000);
    expect(rating.level).toBe('EXCELLENT');
    expect(rating.emoji).toBe('🟢');
  });

  it('should return GOOD for 3-5s', () => {
    const rating = getTTFRRating(4000);
    expect(rating.level).toBe('GOOD');
    expect(rating.emoji).toBe('🟡');
  });

  it('should return PASS for 5-10s', () => {
    const rating = getTTFRRating(7000);
    expect(rating.level).toBe('PASS');
    expect(rating.emoji).toBe('🟠');
  });

  it('should return NEEDS_IMPROVEMENT for > 10s', () => {
    const rating = getTTFRRating(15000);
    expect(rating.level).toBe('NEEDS_IMPROVEMENT');
    expect(rating.emoji).toBe('🔴');
  });
});

describe('TTFR_RATINGS', () => {
  it('should have correct thresholds', () => {
    expect(TTFR_RATINGS.EXCELLENT.maxMs).toBe(3000);
    expect(TTFR_RATINGS.GOOD.maxMs).toBe(5000);
    expect(TTFR_RATINGS.PASS.maxMs).toBe(10000);
    expect(TTFR_RATINGS.NEEDS_IMPROVEMENT.maxMs).toBe(Infinity);
  });
});

describe('getTTFRTracker singleton', () => {
  it('should return the same instance', () => {
    const instance1 = getTTFRTracker();
    const instance2 = getTTFRTracker();
    expect(instance1).toBe(instance2);
  });
});
