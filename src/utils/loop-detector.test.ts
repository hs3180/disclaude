/**
 * Tests for LoopDetector.
 *
 * Issue #963: GLM-5 model stuck in infinite loop reading the same file 2771 times.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LoopDetector, resetLoopDetector, getLoopDetector } from './loop-detector.js';

describe('LoopDetector', () => {
  let detector: LoopDetector;

  beforeEach(() => {
    detector = new LoopDetector({
      maxConsecutiveCalls: 3,
      maxTotalCalls: 10,
      maxFileReads: 5,
    });
  });

  describe('checkToolCall', () => {
    it('should return isLoop: false for normal calls', () => {
      const result = detector.checkToolCall('Read', { file_path: '/tmp/file1.txt' });
      expect(result.isLoop).toBe(false);
    });

    it('should detect consecutive identical calls', () => {
      const input = { file_path: '/tmp/same.txt' };

      // First call - no loop
      let result = detector.checkToolCall('Read', input);
      expect(result.isLoop).toBe(false);

      // Second call - no loop
      result = detector.checkToolCall('Read', input);
      expect(result.isLoop).toBe(false);

      // Third call - no loop (at limit)
      result = detector.checkToolCall('Read', input);
      expect(result.isLoop).toBe(false);

      // Fourth call - should trigger loop detection (exceeds maxConsecutiveCalls=3)
      result = detector.checkToolCall('Read', input);
      expect(result.isLoop).toBe(true);
      expect(result.loopType).toBe('consecutive');
      expect(result.consecutiveCount).toBe(4);
      expect(result.toolName).toBe('Read');
    });

    it('should reset consecutive count when different call is made', () => {
      const input1 = { file_path: '/tmp/file1.txt' };
      const input2 = { file_path: '/tmp/file2.txt' };

      // Two identical calls to input1
      detector.checkToolCall('Read', input1);
      detector.checkToolCall('Read', input1);

      // Switch to input2 - consecutive count should reset
      let result = detector.checkToolCall('Read', input2);
      expect(result.isLoop).toBe(false);

      // Two more calls to input2 (total 3 consecutive to input2)
      detector.checkToolCall('Read', input2);
      result = detector.checkToolCall('Read', input2);
      expect(result.isLoop).toBe(false); // At limit (3), not exceeded

      // Fourth consecutive call to input2 - should trigger loop
      result = detector.checkToolCall('Read', input2);
      expect(result.isLoop).toBe(true);
      expect(result.loopType).toBe('consecutive');
      expect(result.consecutiveCount).toBe(4);
    });

    it('should detect total call limit exceeded', () => {
      const inputs = [
        { file_path: '/tmp/file1.txt' },
        { file_path: '/tmp/file2.txt' },
        { file_path: '/tmp/file3.txt' },
      ];

      // Make 10 calls (maxTotalCalls=10)
      for (let i = 0; i < 10; i++) {
        const result = detector.checkToolCall('Read', inputs[i % 3]);
        expect(result.isLoop).toBe(false);
      }

      // 11th call should trigger loop
      const result = detector.checkToolCall('Read', inputs[0]);
      expect(result.isLoop).toBe(true);
      expect(result.loopType).toBe('total');
      expect(result.totalCount).toBe(11);
    });

    it('should detect file read limit exceeded', () => {
      // Use a detector with high consecutive limit to test file read limit
      const fileDetector = new LoopDetector({
        maxConsecutiveCalls: 10,  // High limit so consecutive doesn't trigger first
        maxTotalCalls: 100,
        maxFileReads: 3,
      });

      const sameFileInput = { file_path: '/tmp/same-file.txt' };

      // Read the same file 3 times (maxFileReads=3)
      for (let i = 0; i < 3; i++) {
        const result = fileDetector.checkToolCall('Read', sameFileInput);
        expect(result.isLoop).toBe(false);
      }

      // 4th read of the same file should trigger loop
      const result = fileDetector.checkToolCall('Read', sameFileInput);
      expect(result.isLoop).toBe(true);
      expect(result.loopType).toBe('file_read');
      expect(result.fileReadCount).toBe(4);
    });

    it('should track different files separately', () => {
      const file1 = { file_path: '/tmp/file1.txt' };
      const file2 = { file_path: '/tmp/file2.txt' };

      // Read file1 3 times
      detector.checkToolCall('Read', file1);
      detector.checkToolCall('Read', file1);
      detector.checkToolCall('Read', file1);

      // Read file2 3 times
      detector.checkToolCall('Read', file2);
      detector.checkToolCall('Read', file2);
      detector.checkToolCall('Read', file2);

      // Neither should trigger loop (each file has different consecutive count)
      let result = detector.checkToolCall('Read', file1);
      expect(result.isLoop).toBe(false);
      result = detector.checkToolCall('Read', file2);
      expect(result.isLoop).toBe(false);
    });
  });

  describe('reset', () => {
    it('should reset all counters', () => {
      const input = { file_path: '/tmp/file.txt' };

      // Trigger consecutive loop
      detector.checkToolCall('Read', input);
      detector.checkToolCall('Read', input);
      detector.checkToolCall('Read', input);
      const loopResult = detector.checkToolCall('Read', input);
      expect(loopResult.isLoop).toBe(true);

      // Reset
      detector.reset();

      // Should start fresh
      const result = detector.checkToolCall('Read', input);
      expect(result.isLoop).toBe(false);
    });
  });

  describe('getStats', () => {
    it('should return correct statistics', () => {
      const file1 = { file_path: '/tmp/file1.txt' };
      const file2 = { file_path: '/tmp/file2.txt' };

      detector.checkToolCall('Read', file1);
      detector.checkToolCall('Read', file1);
      detector.checkToolCall('Read', file2);

      const stats = detector.getStats();
      expect(stats.totalCallCount).toBe(3);
      expect(stats.historyLength).toBe(3);
      expect(stats.topFileReads.length).toBe(2);

      // Most read file should be file1 (2 reads)
      expect(stats.topFileReads[0].file).toBe('/tmp/file1.txt');
      expect(stats.topFileReads[0].count).toBe(2);
    });
  });

  describe('setSessionId', () => {
    it('should set session ID for logging', () => {
      detector.setSessionId('test-session-123');
      // No error should be thrown
    });
  });

  describe('default detector', () => {
    it('getLoopDetector should return singleton', () => {
      resetLoopDetector();
      const detector1 = getLoopDetector();
      const detector2 = getLoopDetector();
      expect(detector1).toBe(detector2);
    });

    it('resetLoopDetector should reset singleton', () => {
      resetLoopDetector();
      const detector1 = getLoopDetector();
      detector1.checkToolCall('Read', { file_path: '/tmp/test.txt' });
      expect(detector1.getStats().totalCallCount).toBe(1);

      resetLoopDetector();

      // After reset, getLoopDetector creates a new instance with fresh state
      const detector2 = getLoopDetector();
      const stats = detector2.getStats();
      expect(stats.totalCallCount).toBe(0);
    });
  });

  describe('input hashing', () => {
    it('should treat objects with same content as identical', () => {
      const input1 = { file_path: '/tmp/file.txt', encoding: 'utf-8' };
      const input2 = { encoding: 'utf-8', file_path: '/tmp/file.txt' }; // Different key order

      // Both should be treated as identical
      detector.checkToolCall('Read', input1);
      detector.checkToolCall('Read', input2);

      // Third call should still be consecutive
      detector.checkToolCall('Read', input1);

      // Fourth should trigger loop
      const result = detector.checkToolCall('Read', input2);
      expect(result.isLoop).toBe(true);
      expect(result.loopType).toBe('consecutive');
    });
  });

  describe('error message and suggested action', () => {
    it('should provide helpful error messages for consecutive loops', () => {
      const input = { file_path: '/tmp/problematic.txt' };

      // Trigger loop
      detector.checkToolCall('Read', input);
      detector.checkToolCall('Read', input);
      detector.checkToolCall('Read', input);
      const result = detector.checkToolCall('Read', input);

      expect(result.message).toBeDefined();
      expect(result.suggestedAction).toBeDefined();
      expect(result.message).toContain('Read');
      expect(result.message).toContain('4 times');
    });

    it('should provide helpful error messages for file read loops', () => {
      // Use a detector with high consecutive limit to test file read limit
      const fileDetector = new LoopDetector({
        maxConsecutiveCalls: 10,
        maxTotalCalls: 100,
        maxFileReads: 2,
      });

      const input = { file_path: '/tmp/problematic-file.txt' };

      // Trigger file read loop
      fileDetector.checkToolCall('Read', input);
      fileDetector.checkToolCall('Read', input);
      const result = fileDetector.checkToolCall('Read', input);

      expect(result.isLoop).toBe(true);
      expect(result.loopType).toBe('file_read');
      expect(result.message).toContain('/tmp/problematic-file.txt');
      expect(result.suggestedAction).toBeDefined();
    });
  });
});
