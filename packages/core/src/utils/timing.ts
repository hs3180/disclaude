/**
 * Lightweight timing wrapper for integration test diagnostics.
 *
 * Issue #3292: Provides a zero-intrusion `withTiming()` wrapper that
 * logs elapsed time at natural boundaries (MCP tools, IPC, HTTP, Agent, WS).
 *
 * @module utils/timing
 */

import type { Logger } from './logger.js';

/**
 * Wrap an async function with timing logs.
 *
 * Logs start (elapsedMs=0), success, or failure with elapsed time.
 * Zero intrusion — does not modify the wrapped function's behavior.
 *
 * @param logger - Logger instance to use for timing output
 * @param label - Label identifying the timed operation (e.g., 'mcp-tool:send_card')
 * @param chatId - Optional chatId for correlation with test cases
 * @param fn - Async function to wrap
 */
export function withTiming<T>(
  logger: Logger,
  label: string,
  chatId: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  logger.info({ chatId, timing: label, elapsedMs: 0 });
  return fn()
    .then(result => {
      logger.info({ chatId, timing: label, elapsedMs: Date.now() - start, ok: true });
      return result;
    })
    .catch(err => {
      logger.info({ chatId, timing: label, elapsedMs: Date.now() - start, ok: false, error: err instanceof Error ? err.message : String(err) });
      throw err;
    });
}
