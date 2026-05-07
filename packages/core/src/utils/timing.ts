/**
 * Timing wrapper for async operations.
 *
 * Logs elapsed time at natural boundaries with zero intrusion to existing logic.
 *
 * Issue #3292: Lightweight alternative to PR #3293's heavy timing infrastructure.
 * Uses wrapper pattern instead of manual instrumentation — no new types,
 * no factories, no repeated logger instances.
 *
 * @module utils/timing
 */

import type { Logger } from 'pino';

/**
 * Wrap an async function call with timing logs.
 *
 * Logs three events:
 * 1. **Start** (elapsedMs: 0) — marks the beginning
 * 2. **Success** (ok: true) — includes total elapsed time
 * 3. **Failure** (ok: false) — includes error message + elapsed time
 *
 * @param logger - Pino Logger instance to write structured logs
 * @param label - Human-readable label (e.g. 'mcp:send_text', 'ipc:handleRequest')
 * @param chatId - Optional chatId for correlation across subsystems
 * @param fn - Async function to time
 * @returns The return value of `fn`, or re-throws its error
 */
export function withTiming<T>(
  logger: Logger,
  label: string,
  chatId: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  logger.debug({ chatId, timing: label, elapsedMs: 0 });
  return fn()
    .then(result => {
      logger.info({ chatId, timing: label, elapsedMs: Date.now() - start, ok: true });
      return result;
    })
    .catch(err => {
      logger.info({ chatId, timing: label, elapsedMs: Date.now() - start, ok: false, error: err.message });
      throw err;
    });
}
