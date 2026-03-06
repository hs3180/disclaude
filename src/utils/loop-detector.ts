/**
 * LoopDetector - Detects infinite loops in tool calls.
 *
 * This module provides protection against infinite loops where the model
 * repeatedly calls the same tool with the same parameters, which can happen
 * with certain models (like GLM-5) when processing malformed content.
 *
 * Issue #963: GLM-5 model stuck in infinite loop reading the same file 2771 times.
 *
 * Detection strategies:
 * 1. Track consecutive identical tool calls
 * 2. Track total tool calls per session
 * 3. Alert when thresholds are exceeded
 *
 * @module utils/loop-detector
 */

import { createLogger } from './logger.js';

const logger = createLogger('LoopDetector');

/**
 * Configuration for LoopDetector.
 */
export interface LoopDetectorConfig {
  /** Maximum consecutive identical tool calls before alert (default: 5) */
  maxConsecutiveCalls?: number;
  /** Maximum total tool calls per session before alert (default: 500) */
  maxTotalCalls?: number;
  /** Maximum calls to the same file before alert (default: 10) */
  maxFileReads?: number;
  /** Number of recent calls to track for pattern detection (default: 20) */
  historySize?: number;
}

/**
 * Represents a tool call for tracking.
 */
interface ToolCallRecord {
  /** Tool name */
  toolName: string;
  /** Tool input parameters (serialized) */
  inputHash: string;
  /** Timestamp of the call */
  timestamp: number;
  /** File path if applicable */
  filePath?: string;
}

/**
 * Result of loop detection check.
 */
export interface LoopDetectionResult {
  /** Whether a loop is detected */
  isLoop: boolean;
  /** Type of loop detected */
  loopType?: 'consecutive' | 'total' | 'file_read';
  /** Number of consecutive identical calls */
  consecutiveCount?: number;
  /** Total call count */
  totalCount?: number;
  /** File read count (if applicable) */
  fileReadCount?: number;
  /** Description of the detected loop */
  message?: string;
  /** Tool name involved in the loop */
  toolName?: string;
  /** Suggested action to break the loop */
  suggestedAction?: string;
}

/**
 * LoopDetector - Detects and alerts on infinite loops in tool calls.
 *
 * @example
 * ```typescript
 * const detector = new LoopDetector({ maxConsecutiveCalls: 5 });
 *
 * // Before each tool call
 * const result = detector.checkToolCall('Read', { file_path: 'report.md' });
 * if (result.isLoop) {
 *   throw new Error(`Loop detected: ${result.message}`);
 * }
 * ```
 */
export class LoopDetector {
  private readonly maxConsecutiveCalls: number;
  private readonly maxTotalCalls: number;
  private readonly maxFileReads: number;
  private readonly historySize: number;

  /** Recent tool call history */
  private readonly callHistory: ToolCallRecord[] = [];

  /** Total tool call count for current session */
  private totalCallCount = 0;

  /** File read counts */
  private readonly fileReadCounts = new Map<string, number>();

  /** Session ID for tracking */
  private sessionId: string | undefined;

  constructor(config: LoopDetectorConfig = {}) {
    this.maxConsecutiveCalls = config.maxConsecutiveCalls ?? 5;
    this.maxTotalCalls = config.maxTotalCalls ?? 500;
    this.maxFileReads = config.maxFileReads ?? 10;
    this.historySize = config.historySize ?? 20;

    logger.debug({
      maxConsecutiveCalls: this.maxConsecutiveCalls,
      maxTotalCalls: this.maxTotalCalls,
      maxFileReads: this.maxFileReads,
    }, 'LoopDetector initialized');
  }

  /**
   * Set the session ID for logging context.
   */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /**
   * Check if a tool call would create a loop.
   *
   * @param toolName - Name of the tool being called
   * @param input - Tool input parameters
   * @returns LoopDetectionResult indicating if a loop is detected
   */
  checkToolCall(toolName: string, input: unknown): LoopDetectionResult {
    // Increment total count
    this.totalCallCount++;

    // Create hash of input for comparison
    const inputHash = this.hashInput(input);
    const filePath = this.extractFilePath(input);

    // Record the call
    const record: ToolCallRecord = {
      toolName,
      inputHash,
      timestamp: Date.now(),
      filePath,
    };

    // Add to history
    this.callHistory.push(record);
    if (this.callHistory.length > this.historySize) {
      this.callHistory.shift();
    }

    // Track file reads
    if (filePath) {
      const count = (this.fileReadCounts.get(filePath) || 0) + 1;
      this.fileReadCounts.set(filePath, count);

      // Check file read limit
      if (count > this.maxFileReads) {
        logger.warn({
          sessionId: this.sessionId,
          toolName,
          filePath,
          count,
          maxFileReads: this.maxFileReads,
        }, 'File read limit exceeded');

        return {
          isLoop: true,
          loopType: 'file_read',
          fileReadCount: count,
          toolName,
          message: `File "${filePath}" has been read ${count} times. This may indicate an infinite loop.`,
          suggestedAction: 'The model may be stuck reading the same file. Consider checking the file content for malformed data or using a different approach.',
        };
      }
    }

    // Check total call limit
    if (this.totalCallCount > this.maxTotalCalls) {
      logger.warn({
        sessionId: this.sessionId,
        totalCallCount: this.totalCallCount,
        maxTotalCalls: this.maxTotalCalls,
      }, 'Total tool call limit exceeded');

      return {
        isLoop: true,
        loopType: 'total',
        totalCount: this.totalCallCount,
        message: `Total tool calls (${this.totalCallCount}) exceeded limit (${this.maxTotalCalls}). This may indicate an infinite loop.`,
        suggestedAction: 'The task may be too complex or the model is stuck. Try breaking down the task or resetting the conversation.',
      };
    }

    // Check consecutive identical calls
    const consecutiveCount = this.countConsecutiveIdentical(record);
    if (consecutiveCount > this.maxConsecutiveCalls) {
      logger.warn({
        sessionId: this.sessionId,
        toolName,
        inputHash,
        consecutiveCount,
        maxConsecutiveCalls: this.maxConsecutiveCalls,
      }, 'Consecutive identical tool calls detected');

      return {
        isLoop: true,
        loopType: 'consecutive',
        consecutiveCount,
        toolName,
        message: `Tool "${toolName}" called ${consecutiveCount} times with identical parameters. This indicates an infinite loop.`,
        suggestedAction: 'The model is stuck in a loop. Try simplifying the task or checking for malformed content in files.',
      };
    }

    // No loop detected
    return { isLoop: false };
  }

  /**
   * Count consecutive identical calls at the end of history.
   */
  private countConsecutiveIdentical(current: ToolCallRecord): number {
    let count = 0;
    for (let i = this.callHistory.length - 1; i >= 0; i--) {
      const record = this.callHistory[i];
      if (record.toolName === current.toolName && record.inputHash === current.inputHash) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  /**
   * Create a hash of tool input for comparison.
   * Uses a simple JSON serialization with sorted keys.
   */
  private hashInput(input: unknown): string {
    try {
      // Sort keys for consistent hashing
      const sorted = this.sortObjectKeys(input);
      return JSON.stringify(sorted);
    } catch {
      return String(input);
    }
  }

  /**
   * Recursively sort object keys for consistent hashing.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sortObjectKeys(obj: any): any {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }
    if (Array.isArray(obj)) {
      return obj.map(item => this.sortObjectKeys(item));
    }
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(obj).sort();
    for (const key of keys) {
      sorted[key] = this.sortObjectKeys(obj[key]);
    }
    return sorted;
  }

  /**
   * Extract file path from tool input if applicable.
   */
  private extractFilePath(input: unknown): string | undefined {
    if (!input || typeof input !== 'object') {
      return undefined;
    }
    const inputObj = input as Record<string, unknown>;
    // Common file path parameter names
    return inputObj.file_path as string | undefined ||
           inputObj.filePath as string | undefined ||
           inputObj.path as string | undefined;
  }

  /**
   * Reset the detector state for a new session.
   */
  reset(): void {
    this.callHistory.length = 0;
    this.totalCallCount = 0;
    this.fileReadCounts.clear();
    this.sessionId = undefined;

    logger.debug('LoopDetector reset');
  }

  /**
   * Get current statistics.
   */
  getStats(): {
    totalCallCount: number;
    historyLength: number;
    topFileReads: Array<{ file: string; count: number }>;
  } {
    const topFileReads = Array.from(this.fileReadCounts.entries())
      .map(([file, count]) => ({ file, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      totalCallCount: this.totalCallCount,
      historyLength: this.callHistory.length,
      topFileReads,
    };
  }
}

/**
 * Default loop detector instance for global use.
 * Can be shared across sessions with per-session tracking via sessionId.
 */
let defaultDetector: LoopDetector | undefined;

/**
 * Get or create the default loop detector.
 */
export function getLoopDetector(config?: LoopDetectorConfig): LoopDetector {
  if (!defaultDetector) {
    defaultDetector = new LoopDetector(config);
  }
  return defaultDetector;
}

/**
 * Reset the default loop detector.
 */
export function resetLoopDetector(): void {
  if (defaultDetector) {
    defaultDetector.reset();
  }
  defaultDetector = undefined;
}
