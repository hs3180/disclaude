/**
 * TTFR (Time to First Response) Tracker.
 *
 * Tracks the time from user message receipt to agent's first response.
 * Implements Issue #855.
 *
 * @module metrics/ttfr-tracker
 */

import { createLogger } from '../utils/logger.js';
import * as fs from 'fs';
import * as path from 'path';

const logger = createLogger('TTFRTracker');

/**
 * Single TTFR record.
 */
export interface TTFRRecord {
  /** Chat ID */
  chatId: string;
  /** User message ID */
  userMessageId: string;
  /** User message timestamp (ms) */
  userMessageTime: number;
  /** First response timestamp (ms) */
  firstResponseTime: number;
  /** TTFR in milliseconds */
  ttfrMs: number;
  /** Model used for response (optional) */
  model?: string;
  /** Record creation time */
  createdAt: string;
}

/**
 * TTFR statistics for a period.
 */
export interface TTFRStats {
  /** Total records count */
  count: number;
  /** Average TTFR in ms */
  avgMs: number;
  /** Minimum TTFR in ms */
  minMs: number;
  /** Maximum TTFR in ms */
  maxMs: number;
  /** P50 (median) TTFR in ms */
  p50Ms: number;
  /** P90 TTFR in ms */
  p90Ms: number;
  /** P99 TTFR in ms */
  p99Ms: number;
  /** Time period */
  period: {
    start: string;
    end: string;
  };
}

/**
 * Pending user message awaiting response.
 */
interface PendingMessage {
  chatId: string;
  messageId: string;
  timestamp: number;
}

/**
 * TTFR rating levels.
 */
export const TTFR_RATINGS = {
  EXCELLENT: { maxMs: 3000, label: '优秀', emoji: '🟢' },
  GOOD: { maxMs: 5000, label: '良好', emoji: '🟡' },
  PASS: { maxMs: 10000, label: '及格', emoji: '🟠' },
  NEEDS_IMPROVEMENT: { maxMs: Infinity, label: '需改进', emoji: '🔴' },
} as const;

/**
 * Get TTFR rating for a given value.
 */
export function getTTFRRating(ttfrMs: number): { label: string; emoji: string; level: string } {
  if (ttfrMs < TTFR_RATINGS.EXCELLENT.maxMs) {
    return { ...TTFR_RATINGS.EXCELLENT, level: 'EXCELLENT' };
  }
  if (ttfrMs < TTFR_RATINGS.GOOD.maxMs) {
    return { ...TTFR_RATINGS.GOOD, level: 'GOOD' };
  }
  if (ttfrMs < TTFR_RATINGS.PASS.maxMs) {
    return { ...TTFR_RATINGS.PASS, level: 'PASS' };
  }
  return { ...TTFR_RATINGS.NEEDS_IMPROVEMENT, level: 'NEEDS_IMPROVEMENT' };
}

/**
 * TTFR Tracker class.
 *
 * Tracks time-to-first-response metrics for user messages.
 */
export class TTFRTracker {
  private dataDir: string;
  private recordsFile: string;
  private pendingMessages: Map<string, PendingMessage> = new Map();
  private records: TTFRRecord[] = [];
  private initialized = false;
  private maxRecords = 10000; // Keep last 10k records in memory

  constructor(dataDir?: string) {
    this.dataDir = dataDir || path.join(process.cwd(), 'workspace', 'metrics');
    this.recordsFile = path.join(this.dataDir, 'ttfr-records.json');
  }

  /**
   * Initialize the tracker (load existing records).
   */
  init(): void {
    if (this.initialized) {
      return;
    }

    try {
      // Ensure directory exists
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }

      // Load existing records
      if (fs.existsSync(this.recordsFile)) {
        const data = fs.readFileSync(this.recordsFile, 'utf-8');
        this.records = JSON.parse(data);
        logger.info({ count: this.records.length }, 'Loaded TTFR records');
      }

      this.initialized = true;
    } catch (error) {
      logger.error({ err: error }, 'Failed to initialize TTFR tracker');
      this.records = [];
      this.initialized = true;
    }
  }

  /**
   * Record a user message (start of TTFR measurement).
   */
  recordUserMessage(chatId: string, messageId: string, timestamp?: number): void {
    const ts = timestamp || Date.now();
    const key = `${chatId}:${messageId}`;

    this.pendingMessages.set(key, {
      chatId,
      messageId,
      timestamp: ts,
    });

    logger.debug({ chatId, messageId, timestamp: ts }, 'Recorded user message for TTFR tracking');
  }

  /**
   * Record agent's first response (end of TTFR measurement).
   * Returns the TTFR value if a pending message was found, undefined otherwise.
   */
  recordFirstResponse(
    chatId: string,
    model?: string
  ): { ttfrMs: number; userMessageId: string } | undefined {
    // Find the most recent pending message for this chat
    let latestPending: PendingMessage | undefined;
    let latestKey: string | undefined;

    for (const [key, pending] of this.pendingMessages) {
      if (pending.chatId === chatId) {
        if (!latestPending || pending.timestamp > latestPending.timestamp) {
          latestPending = pending;
          latestKey = key;
        }
      }
    }

    if (!latestPending || !latestKey) {
      logger.debug({ chatId }, 'No pending user message found for TTFR calculation');
      return undefined;
    }

    const responseTime = Date.now();
    const ttfrMs = responseTime - latestPending.timestamp;

    // Create record
    const record: TTFRRecord = {
      chatId,
      userMessageId: latestPending.messageId,
      userMessageTime: latestPending.timestamp,
      firstResponseTime: responseTime,
      ttfrMs,
      model,
      createdAt: new Date().toISOString(),
    };

    // Remove from pending
    this.pendingMessages.delete(latestKey);

    // Add to records
    this.addRecord(record);

    const rating = getTTFRRating(ttfrMs);
    logger.info(
      {
        chatId,
        userMessageId: latestPending.messageId,
        ttfrMs,
        rating: rating.label,
      },
      'TTFR recorded'
    );

    return { ttfrMs, userMessageId: latestPending.messageId };
  }

  /**
   * Add a record to storage.
   */
  private addRecord(record: TTFRRecord): void {
    this.records.push(record);

    // Trim to max records
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords);
    }

    // Persist to file
    this.persist();
  }

  /**
   * Persist records to file.
   */
  private persist(): void {
    try {
      const data = JSON.stringify(this.records, null, 2);
      fs.writeFileSync(this.recordsFile, data, 'utf-8');
    } catch (error) {
      logger.error({ err: error }, 'Failed to persist TTFR records');
    }
  }

  /**
   * Get all records.
   */
  getRecords(): TTFRRecord[] {
    return [...this.records];
  }

  /**
   * Get records filtered by options.
   */
  getRecordsFiltered(options?: {
    chatId?: string;
    startTime?: number;
    endTime?: number;
    limit?: number;
  }): TTFRRecord[] {
    let filtered = [...this.records];

    if (options?.chatId) {
      filtered = filtered.filter((r) => r.chatId === options.chatId);
    }

    if (options?.startTime) {
      filtered = filtered.filter((r) => r.userMessageTime >= options.startTime!);
    }

    if (options?.endTime) {
      filtered = filtered.filter((r) => r.userMessageTime <= options.endTime!);
    }

    // Sort by time descending
    filtered.sort((a, b) => b.userMessageTime - a.userMessageTime);

    if (options?.limit) {
      filtered = filtered.slice(0, options.limit);
    }

    return filtered;
  }

  /**
   * Calculate statistics for a set of records.
   */
  calculateStats(records: TTFRRecord[]): TTFRStats | null {
    if (records.length === 0) {
      return null;
    }

    const ttfrValues = records.map((r) => r.ttfrMs).sort((a, b) => a - b);

    const sum = ttfrValues.reduce((acc, val) => acc + val, 0);
    const avgMs = sum / ttfrValues.length;
    const [minMs] = ttfrValues;
    const maxMs = ttfrValues.at(-1) as number;

    // Percentiles
    const p50Index = Math.floor(ttfrValues.length * 0.5);
    const p90Index = Math.floor(ttfrValues.length * 0.9);
    const p99Index = Math.floor(ttfrValues.length * 0.99);

    const timestamps = records.map((r) => r.userMessageTime).sort((a, b) => a - b);

    return {
      count: records.length,
      avgMs: Math.round(avgMs),
      minMs,
      maxMs,
      p50Ms: ttfrValues[p50Index],
      p90Ms: ttfrValues[p90Index],
      p99Ms: ttfrValues[p99Index],
      period: {
        start: new Date(timestamps[0]).toISOString(),
        end: new Date(timestamps[timestamps.length - 1]).toISOString(),
      },
    };
  }

  /**
   * Get statistics for a chat.
   */
  getStatsForChat(chatId: string, startTime?: number, endTime?: number): TTFRStats | null {
    const records = this.getRecordsFiltered({ chatId, startTime, endTime });
    return this.calculateStats(records);
  }

  /**
   * Get global statistics.
   */
  getGlobalStats(startTime?: number, endTime?: number): TTFRStats | null {
    const records = this.getRecordsFiltered({ startTime, endTime });
    return this.calculateStats(records);
  }

  /**
   * Clear all records (for testing).
   */
  clear(): void {
    this.records = [];
    this.pendingMessages.clear();
  }

  /**
   * Get count of pending messages (for testing/debugging).
   */
  getPendingCount(): number {
    return this.pendingMessages.size;
  }
}

// Singleton instance
let trackerInstance: TTFRTracker | null = null;

/**
 * Get the singleton TTFR tracker instance.
 */
export function getTTFRTracker(): TTFRTracker {
  if (!trackerInstance) {
    trackerInstance = new TTFRTracker();
  }
  return trackerInstance;
}

/**
 * Initialize the TTFR tracker.
 */
export function initTTFRTracker(): void {
  const tracker = getTTFRTracker();
  tracker.init();
}
