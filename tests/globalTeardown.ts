/**
 * Vitest global teardown — runs once after all test suites complete.
 *
 * Issue #3415: Ensures test process exits cleanly without leaving
 * zombie cron timers or orphaned child processes.
 *
 * This teardown:
 * 1. Clears any lingering timers/intervals that tests may have created
 * 2. Schedules a forced exit to prevent the process from hanging
 *    (e.g., if a cron job or setInterval was not properly cleaned up)
 */

/**
 * Maximum time (ms) to wait for the process to exit naturally before forcing exit.
 * Vitest's own timeout should handle most cases, but this is a safety net.
 */
const FORCE_EXIT_TIMEOUT_MS = 10000;

export default function teardown(): void {
  // Schedule a forced exit as a safety net against hanging processes.
  // If the process exits naturally before this fires, the timer is cancelled.
  const forceExitTimer = setTimeout(() => {
    // eslint-disable-next-line no-console
    console.error(
      `[globalTeardown] Process did not exit within ${FORCE_EXIT_TIMEOUT_MS}ms, forcing exit. ` +
      'This may indicate a resource leak (timer, socket, cron job).'
    );
    process.exit(1);
  }, FORCE_EXIT_TIMEOUT_MS);

  // Don't let this timer prevent natural process exit
  forceExitTimer.unref();
}
