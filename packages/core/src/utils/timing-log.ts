/**
 * TimingLog - Unified timing log utility for integration test diagnostics.
 *
 * Issue #3292: Provides consistent timing log format across all critical paths
 * to help diagnose intermittent integration test timeouts.
 *
 * Log Format:
 * ```
 * {"level":"info","context":"TimingLog","chatId":"xxx","phase":"mcp-tool-call","tool":"send_card","elapsedMs":1234,"totalMs":5678}
 * ```
 *
 * Key elements:
 * - Unified `TimingLog` context for easy grep/filtering
 * - `chatId` for correlation with specific test cases
 * - `phase` to identify the stage
 * - `elapsedMs` for current stage duration
 * - `totalMs` for cumulative time from request start
 *
 * @module utils/timing-log
 */

import type { Logger } from './logger.js';

/**
 * Standard phases for timing logs.
 */
export type TimingPhase =
  | 'agent-startup'
  | 'agent-ttft'
  | 'agent-loop-iteration'
  | 'agent-turn-complete'
  | 'mcp-tool-call'
  | 'http-request-received'
  | 'http-request-dispatched'
  | 'http-response-sent'
  | 'ipc-request'
  | 'ipc-response'
  | 'ipc-error'
  | 'ws-connection-change'
  | 'concurrency-snapshot';

/**
 * Timing log data structure.
 */
export interface TimingLogData {
  /** Chat ID for correlation */
  chatId?: string;
  /** Phase identifier */
  phase: TimingPhase;
  /** Current stage duration in ms */
  elapsedMs: number;
  /** Cumulative time from request start in ms */
  totalMs?: number;
  /** Tool name (for mcp-tool-call phase) */
  tool?: string;
  /** Tool call parameters summary (for mcp-tool-call phase) */
  toolParams?: string;
  /** IPC request type (for ipc-request/ipc-response/ipc-error phase) */
  ipcType?: string;
  /** Whether the operation succeeded */
  success?: boolean;
  /** Error message if failed */
  error?: string;
  /** Additional context-specific fields */
  [key: string]: unknown;
}

/**
 * Log a timing event with the standardized format.
 *
 * @param logger - Logger instance to use
 * @param data - Timing log data
 * @param message - Optional message (defaults to phase value)
 */
export function logTiming(logger: Logger, data: TimingLogData, message?: string): void {
  const { phase, elapsedMs, ...rest } = data;

  logger.info(
    {
      ...rest,
      phase,
      elapsedMs,
    },
    message ?? `TimingLog: ${phase}`
  );
}

/**
 * Create a timing tracker for a request lifecycle.
 *
 * Usage:
 * ```typescript
 * const tracker = createRequestTracker(logger, 'test-chat-123');
 * tracker.log('http-request-received', { totalMs: 0 });
 * // ... processing ...
 * tracker.log('mcp-tool-call', { tool: 'send_card', totalMs: tracker.totalMs() });
 * ```
 *
 * @param logger - Logger instance
 * @param chatId - Chat ID for correlation
 * @returns Tracker object with log and totalMs helpers
 */
export function createRequestTracker(logger: Logger, chatId: string) {
  const startMs = Date.now();

  return {
    /** Log a timing event with auto-calculated elapsedMs */
    log(phase: TimingPhase, extra?: Omit<TimingLogData, 'phase' | 'chatId' | 'elapsedMs'>): void {
      logTiming(logger, {
        chatId,
        phase,
        elapsedMs: Date.now() - startMs,
        ...extra,
      });
    },

    /** Get total elapsed ms since tracker creation */
    totalMs(): number {
      return Date.now() - startMs;
    },

    /** Get the start timestamp */
    startMs(): number {
      return startMs;
    },
  };
}

export type RequestTracker = ReturnType<typeof createRequestTracker>;
