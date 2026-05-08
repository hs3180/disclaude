/**
 * Test Resource Tracker - Automatic cleanup for test resources.
 *
 * Prevents test resource leaks (schedulers, cron jobs, timers) that cause:
 * - Test process hanging (forcing SIGKILL by vitest)
 * - Orphaned cron entries persisting between test runs
 * - Interference between test files in singleFork mode
 *
 * Usage in test files:
 * ```typescript
 * import { trackResource } from '../../tests/test-resource-tracker.js';
 *
 * // Scheduler is auto-cleaned after this test file completes
 * const scheduler = trackResource(new Scheduler({ ... }));
 * ```
 *
 * Issue #3415: Test process not exiting gracefully, cron not cleaned up.
 */

/**
 * Minimal interface for resources that can be stopped.
 * Compatible with Scheduler, PrimaryNode, and similar classes.
 */
interface StoppableResource {
  isRunning(): boolean;
  stop(): void;
}

/** Tracked stoppable resources (schedulers, nodes, etc.) */
const trackedResources: Set<StoppableResource> = new Set();

/** Custom cleanup callbacks for non-standard resources */
const cleanupCallbacks: Set<() => Promise<void> | void> = new Set();

/**
 * Track a stoppable resource for automatic cleanup.
 *
 * The resource's `stop()` method will be called during cleanup
 * if it reports `isRunning() === true`.
 *
 * @param resource - Resource with `isRunning()` and `stop()` methods
 * @returns The same resource (for convenient chaining)
 *
 * @example
 * ```typescript
 * const scheduler = trackResource(new Scheduler({ ... }));
 * // scheduler.stop() is called automatically in afterAll
 * ```
 */
export function trackResource<T extends StoppableResource>(resource: T): T {
  trackedResources.add(resource);
  return resource;
}

/**
 * Stop tracking a resource (e.g., after manual cleanup).
 *
 * @param resource - Resource to untrack
 */
export function untrackResource<T extends StoppableResource>(resource: T): void {
  trackedResources.delete(resource);
}

/**
 * Register a custom cleanup callback.
 * Called during `cleanupAllTracked()` in addition to stopping tracked resources.
 *
 * @param callback - Function to call during cleanup
 */
export function registerCleanup(callback: () => Promise<void> | void): void {
  cleanupCallbacks.add(callback);
}

/**
 * Remove a previously registered cleanup callback.
 *
 * @param callback - Callback to remove
 */
export function unregisterCleanup(callback: () => Promise<void> | void): void {
  cleanupCallbacks.delete(callback);
}

/**
 * Clean up all tracked resources and run all cleanup callbacks.
 *
 * Safe to call multiple times (idempotent).
 * Errors during cleanup are logged but don't prevent other cleanup from running.
 *
 * Called automatically by vitest's afterAll hook (registered in setup.ts).
 */
export async function cleanupAllTracked(): Promise<void> {
  const errors: unknown[] = [];

  // Run custom cleanup callbacks first (e.g., closing connections)
  for (const cb of cleanupCallbacks) {
    try {
      await cb();
    } catch (e) {
      errors.push(e);
    }
  }
  cleanupCallbacks.clear();

  // Stop all tracked resources (schedulers, nodes, etc.)
  for (const resource of trackedResources) {
    try {
      if (resource.isRunning()) {
        resource.stop();
      }
    } catch (e) {
      errors.push(e);
    }
  }
  trackedResources.clear();

  if (errors.length > 0) {
    console.warn(
      `[test-resource-tracker] ${errors.length} error(s) during cleanup:`,
      errors
    );
  }
}

/**
 * Get the count of currently tracked resources (for testing/debugging).
 *
 * @returns Number of tracked resources + registered callbacks
 */
export function getTrackedCount(): number {
  return trackedResources.size + cleanupCallbacks.size;
}
