/**
 * Tests for Test Resource Tracker.
 *
 * Verifies that the resource tracking and cleanup mechanism works correctly,
 * ensuring test resources (schedulers, nodes) are properly cleaned up after
 * each test file.
 *
 * Issue #3415: Test process not exiting gracefully, cron not cleaned up.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  trackResource,
  untrackResource,
  registerCleanup,
  unregisterCleanup,
  cleanupAllTracked,
  getTrackedCount,
} from './test-resource-tracker.js';

/**
 * Create a mock StoppableResource for testing.
 */
function createMockResource(options: { running?: boolean; stopError?: Error } = {}) {
  return {
    isRunning: vi.fn().mockReturnValue(options.running ?? true),
    stop: options.stopError
      ? vi.fn().mockImplementation(() => { throw options.stopError; })
      : vi.fn(),
  };
}

describe('test-resource-tracker', () => {
  beforeEach(async () => {
    // Clean up any leftover state from previous tests
    await cleanupAllTracked();
  });

  describe('trackResource / untrackResource', () => {
    it('should track a resource', () => {
      const resource = createMockResource();
      const result = trackResource(resource);

      // Returns the same resource for chaining
      expect(result).toBe(resource);
      expect(getTrackedCount()).toBe(1);
    });

    it('should track multiple resources', () => {
      trackResource(createMockResource());
      trackResource(createMockResource());
      trackResource(createMockResource());

      expect(getTrackedCount()).toBe(3);
    });

    it('should not duplicate already-tracked resources', () => {
      const resource = createMockResource();
      trackResource(resource);
      trackResource(resource);

      // Set deduplicates
      expect(getTrackedCount()).toBe(1);
    });

    it('should untrack a resource', () => {
      const resource = createMockResource();
      trackResource(resource);
      expect(getTrackedCount()).toBe(1);

      untrackResource(resource);
      expect(getTrackedCount()).toBe(0);
    });

    it('should handle untracking non-tracked resource gracefully', () => {
      const resource = createMockResource();
      expect(() => untrackResource(resource)).not.toThrow();
    });
  });

  describe('registerCleanup / unregisterCleanup', () => {
    it('should register a cleanup callback', () => {
      const cb = vi.fn();
      registerCleanup(cb);

      expect(getTrackedCount()).toBe(1);
    });

    it('should unregister a cleanup callback', () => {
      const cb = vi.fn();
      registerCleanup(cb);
      expect(getTrackedCount()).toBe(1);

      unregisterCleanup(cb);
      expect(getTrackedCount()).toBe(0);
    });

    it('should handle unregistering non-registered callback gracefully', () => {
      const cb = vi.fn();
      expect(() => unregisterCleanup(cb)).not.toThrow();
    });
  });

  describe('cleanupAllTracked', () => {
    it('should stop running resources', async () => {
      const resource = createMockResource({ running: true });
      trackResource(resource);

      await cleanupAllTracked();

      expect(resource.stop).toHaveBeenCalledTimes(1);
      expect(getTrackedCount()).toBe(0);
    });

    it('should not stop non-running resources', async () => {
      const resource = createMockResource({ running: false });
      trackResource(resource);

      await cleanupAllTracked();

      expect(resource.stop).not.toHaveBeenCalled();
      expect(getTrackedCount()).toBe(0);
    });

    it('should run cleanup callbacks', async () => {
      const cb = vi.fn();
      registerCleanup(cb);

      await cleanupAllTracked();

      expect(cb).toHaveBeenCalledTimes(1);
      expect(getTrackedCount()).toBe(0);
    });

    it('should run cleanup callbacks before stopping resources', async () => {
      const order: string[] = [];
      const cb = vi.fn(() => order.push('callback'));
      registerCleanup(cb);

      const resource = createMockResource({ running: true });
      resource.stop.mockImplementation(() => order.push('stop'));
      trackResource(resource);

      await cleanupAllTracked();

      expect(order).toEqual(['callback', 'stop']);
    });

    it('should handle async cleanup callbacks', async () => {
      const cb = vi.fn().mockResolvedValue(undefined);
      registerCleanup(cb);

      await cleanupAllTracked();

      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('should handle errors in cleanup callbacks gracefully', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const failingCb = vi.fn().mockRejectedValue(new Error('callback failed'));
      const succeedingCb = vi.fn().mockResolvedValue(undefined);
      registerCleanup(failingCb);
      registerCleanup(succeedingCb);

      await cleanupAllTracked();

      // Both callbacks should be attempted
      expect(failingCb).toHaveBeenCalledTimes(1);
      expect(succeedingCb).toHaveBeenCalledTimes(1);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('1 error(s) during cleanup'),
        expect.any(Array),
      );

      consoleWarnSpy.mockRestore();
    });

    it('should handle errors in resource stop gracefully', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const resource = createMockResource({
        running: true,
        stopError: new Error('stop failed'),
      });
      trackResource(resource);

      await cleanupAllTracked();

      expect(resource.stop).toHaveBeenCalledTimes(1);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('1 error(s) during cleanup'),
        expect.any(Array),
      );

      consoleWarnSpy.mockRestore();
    });

    it('should be idempotent (safe to call multiple times)', async () => {
      const resource = createMockResource({ running: true });
      trackResource(resource);

      await cleanupAllTracked();
      await cleanupAllTracked(); // Second call should be no-op

      expect(resource.stop).toHaveBeenCalledTimes(1);
      expect(getTrackedCount()).toBe(0);
    });

    it('should clean up mixed resources and callbacks', async () => {
      const cb = vi.fn();
      registerCleanup(cb);

      const resource1 = createMockResource({ running: true });
      const resource2 = createMockResource({ running: false });
      trackResource(resource1);
      trackResource(resource2);

      await cleanupAllTracked();

      expect(cb).toHaveBeenCalledTimes(1);
      expect(resource1.stop).toHaveBeenCalledTimes(1);
      expect(resource2.stop).not.toHaveBeenCalled();
      expect(getTrackedCount()).toBe(0);
    });
  });
});
