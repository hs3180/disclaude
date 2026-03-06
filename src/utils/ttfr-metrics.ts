/**
 * TTFR (Time to First Response) Metrics Module.
 *
 * Tracks the time from user message receipt to Agent's first response.
 * Issue #855: Add user message first response time metrics
 *
 * @module utils/ttfr-metrics
 */

import { createLogger } from './logger.js';

const logger = createLogger('TTFRMetrics');

/**
 * TTFR metric record structure
 */
export interface TTFRRecord {
  /** User message ID that triggered the response */
  userMessageId: string;
  /** Chat ID */
  chatId: string;
  /** User message receive timestamp (ms) */
  userMessageTime: number;
  /** First response send timestamp (ms) */
  firstResponseTime: number;
  /** TTFR in milliseconds */
  ttfrMs: number;
  /** Model used for the response (optional) */
  model?: string;
}

/**
 * TTFR statistics for a time period
 */
export interface TTFRStats {
  /** Number of samples */
  count: number;
  /** Average TTFR in ms */
  avgMs: number;
  /** Minimum TTFR in ms */
  minMs: number;
  /** Maximum TTFR in ms */
  maxMs: number;
  /** P50 TTFR in ms */
  p50Ms: number;
  /** P90 TTFR in ms */
  p90Ms: number;
  /** P99 TTFR in ms */
  p99Ms: number;
}

/**
 * Pending TTFR tracking entry
 */
interface PendingTTFR {
  chatId: string;
  userMessageId: string;
  startTime: number;
}

/**
 * TTFR Metrics Manager.
 *
 * Tracks and records Time to First Response metrics for chat messages.
 * Designed to be non-intrusive and lightweight.
 *
 * Features:
 * - Track start time when user message is received
 * - Calculate TTFR when first response is sent
 * - In-memory storage with configurable max size
 * - Statistics calculation (avg, p50, p90, p99)
 *
 * @example
 * ```typescript
 * import { ttfrMetrics } from './utils/ttfr-metrics.js';
 *
 * // When user message is received
 * ttfrMetrics.startTracking(chatId, userMessageId);
 *
 * // When first response is sent
 * ttfrMetrics.recordResponse(chatId, botMessageId);
 * ```
 */
export class TTFRMetricsManager {
  /** Maximum number of records to keep in memory */
  private maxRecords: number;

  /** TTFR records storage */
  private records: TTFRRecord[] = [];

  /** Map of chatId to pending TTFR tracking (first response only per conversation turn) */
  private pendingTracking: Map<string, PendingTTFR> = new Map();

  /** Map to track if a response has been sent for a chat's current turn */
  private responseSent: Map<string, boolean> = new Map();

  /**
   * Create a TTFR Metrics Manager.
   *
   * @param maxRecords - Maximum records to keep (default: 10000)
   */
  constructor(maxRecords: number = 10000) {
    this.maxRecords = maxRecords;
  }

  /**
   * Start tracking TTFR for a chat.
   * This should be called when a user message is received.
   *
   * @param chatId - Chat ID
   * @param userMessageId - User message ID
   */
  startTracking(chatId: string, userMessageId: string): void {
    const startTime = Date.now();

    this.pendingTracking.set(chatId, {
      chatId,
      userMessageId,
      startTime,
    });

    // Reset response sent flag for this chat
    this.responseSent.set(chatId, false);

    logger.debug(
      { chatId, userMessageId, startTime },
      'TTFR tracking started'
    );
  }

  /**
   * Record a response and calculate TTFR if this is the first response.
   * This should be called when the Agent sends a message.
   *
   * @param chatId - Chat ID
   * @param botMessageId - Bot message ID (optional, for logging)
   * @param model - Model used for the response (optional)
   * @returns The TTFR record if this was the first response, null otherwise
   */
  recordResponse(chatId: string, botMessageId?: string, model?: string): TTFRRecord | null {
    const pending = this.pendingTracking.get(chatId);

    if (!pending) {
      logger.debug({ chatId }, 'No pending TTFR tracking for chat');
      return null;
    }

    // Check if we already recorded the first response for this turn
    if (this.responseSent.get(chatId)) {
      logger.debug({ chatId }, 'First response already recorded, skipping TTFR');
      return null;
    }

    const responseTime = Date.now();
    const ttfrMs = responseTime - pending.startTime;

    const record: TTFRRecord = {
      userMessageId: pending.userMessageId,
      chatId: pending.chatId,
      userMessageTime: pending.startTime,
      firstResponseTime: responseTime,
      ttfrMs,
      model,
    };

    // Mark response as sent for this turn
    this.responseSent.set(chatId, true);

    // Add to records
    this.addRecord(record);

    // Log the TTFR metric
    logger.info(
      {
        chatId,
        userMessageId: pending.userMessageId,
        botMessageId,
        ttfrMs,
        model,
        rating: this.getTTFRRating(ttfrMs),
      },
      'TTFR metric recorded'
    );

    return record;
  }

  /**
   * Clear the tracking state for a chat.
   * This should be called when a new user message is received.
   *
   * @param chatId - Chat ID
   */
  clearTracking(chatId: string): void {
    this.pendingTracking.delete(chatId);
    this.responseSent.delete(chatId);
    logger.debug({ chatId }, 'TTFR tracking cleared');
  }

  /**
   * Add a TTFR record to storage.
   * Maintains the max size limit by removing oldest records.
   */
  private addRecord(record: TTFRRecord): void {
    this.records.push(record);

    // Remove oldest records if over limit
    if (this.records.length > this.maxRecords) {
      const removeCount = this.records.length - this.maxRecords;
      this.records.splice(0, removeCount);
    }
  }

  /**
   * Get all TTFR records.
   *
   * @param chatId - Optional chat ID to filter by
   * @returns Array of TTFR records
   */
  getRecords(chatId?: string): TTFRRecord[] {
    if (chatId) {
      return this.records.filter(r => r.chatId === chatId);
    }
    return [...this.records];
  }

  /**
   * Get TTFR statistics.
   *
   * @param chatId - Optional chat ID to filter by
   * @param since - Optional timestamp to filter records from
   * @returns TTFR statistics
   */
  getStats(chatId?: string, since?: number): TTFRStats | null {
    let records = chatId
      ? this.records.filter(r => r.chatId === chatId)
      : this.records;

    if (since) {
      records = records.filter(r => r.userMessageTime >= since);
    }

    if (records.length === 0) {
      return null;
    }

    const ttfrValues = records.map(r => r.ttfrMs).sort((a, b) => a - b);

    return {
      count: records.length,
      avgMs: Math.round(ttfrValues.reduce((a, b) => a + b, 0) / ttfrValues.length),
      minMs: ttfrValues[0],
      maxMs: ttfrValues[ttfrValues.length - 1],
      p50Ms: this.percentile(ttfrValues, 50),
      p90Ms: this.percentile(ttfrValues, 90),
      p99Ms: this.percentile(ttfrValues, 99),
    };
  }

  /**
   * Calculate percentile value.
   */
  private percentile(sortedValues: number[], p: number): number {
    if (sortedValues.length === 0) return 0;
    if (sortedValues.length === 1) return sortedValues[0];

    const index = Math.ceil((p / 100) * sortedValues.length) - 1;
    return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))];
  }

  /**
   * Get TTFR rating based on time.
   *
   * @param ttfrMs - TTFR in milliseconds
   * @returns Rating string
   */
  getTTFRRating(ttfrMs: number): 'excellent' | 'good' | 'acceptable' | 'needs_improvement' {
    if (ttfrMs < 3000) return 'excellent';
    if (ttfrMs < 5000) return 'good';
    if (ttfrMs < 10000) return 'acceptable';
    return 'needs_improvement';
  }

  /**
   * Clear all records.
   */
  clearAll(): void {
    this.records = [];
    this.pendingTracking.clear();
    this.responseSent.clear();
    logger.info('All TTFR records cleared');
  }

  /**
   * Get current tracking status for debugging.
   */
  getTrackingStatus(): { pendingCount: number; recordCount: number } {
    return {
      pendingCount: this.pendingTracking.size,
      recordCount: this.records.length,
    };
  }
}

/**
 * Global TTFR metrics instance.
 * Singleton pattern for easy access across the application.
 */
export const ttfrMetrics = new TTFRMetricsManager();
