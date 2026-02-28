/**
 * Pattern Store - Persistent storage for detected patterns.
 *
 * Stores analysis results and detected patterns to:
 * - Track patterns over time
 * - Avoid duplicate analysis
 * - Maintain pattern history
 *
 * Storage structure:
 * - workspace/analysis/patterns/{chatId}.json - Per-chat patterns
 * - workspace/analysis/latest.json - Latest full analysis result
 *
 * @see Issue #357 - Intelligent Scheduled Task Recommendation System
 */

import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../utils/logger.js';
import type {
  DetectedPattern,
  ChatAnalysisResult,
  AnalysisResult,
  PatternStoreOptions,
  PatternStatus,
} from './types.js';

const logger = createLogger('PatternStore');

/**
 * Pattern Store - Manages persistent storage of detected patterns.
 *
 * Usage:
 * ```typescript
 * const store = new PatternStore({ dataDir: './workspace/analysis' });
 * await store.init();
 *
 * // Save patterns for a chat
 * await store.saveChatPatterns(chatId, patterns);
 *
 * // Get patterns for a chat
 * const patterns = await store.getChatPatterns(chatId);
 *
 * // Get all pending patterns (for user confirmation)
 * const pending = await store.getPendingPatterns();
 * ```
 */
export class PatternStore {
  private dataDir: string;
  private patternsDir: string;
  private initialized = false;

  constructor(options: PatternStoreOptions) {
    this.dataDir = options.dataDir;
    this.patternsDir = path.join(this.dataDir, 'patterns');
  }

  /**
   * Initialize the pattern store.
   * Creates necessary directories.
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      await fs.mkdir(this.dataDir, { recursive: true });
      await fs.mkdir(this.patternsDir, { recursive: true });
      this.initialized = true;
      logger.info({ dataDir: this.dataDir }, 'PatternStore initialized');
    } catch (error) {
      logger.error({ err: error }, 'Failed to initialize PatternStore');
      throw error;
    }
  }

  /**
   * Get the file path for a chat's patterns.
   */
  private getChatPatternsPath(chatId: string): string {
    const sanitizedId = this.sanitizeId(chatId);
    return path.join(this.patternsDir, `${sanitizedId}.json`);
  }

  /**
   * Sanitize ID for use as filename.
   */
  private sanitizeId(id: string): string {
    return id.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  /**
   * Generate a unique pattern ID.
   */
  private generatePatternId(chatId: string, taskType: string): string {
    const timestamp = Date.now();
    const hash = this.simpleHash(`${chatId}:${taskType}:${timestamp}`);
    return `pattern-${hash}`;
  }

  /**
   * Simple hash function for generating IDs.
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(16);
  }

  /**
   * Save patterns for a specific chat.
   *
   * @param chatId - Chat ID
   * @param result - Analysis result for the chat
   */
  async saveChatPatterns(chatId: string, result: ChatAnalysisResult): Promise<void> {
    await this.ensureInitialized();

    const filePath = this.getChatPatternsPath(chatId);

    try {
      // Load existing patterns
      const existingPatterns = await this.getChatPatterns(chatId);

      // Merge with new patterns
      const mergedPatterns = this.mergePatterns(existingPatterns, result.patterns);

      // Save merged result
      const data: ChatAnalysisResult = {
        chatId,
        patterns: mergedPatterns,
        analyzedAt: result.analyzedAt,
        messageCount: result.messageCount,
        timeRange: result.timeRange,
      };

      await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
      logger.info({ chatId, patternCount: mergedPatterns.length }, 'Saved chat patterns');
    } catch (error) {
      logger.error({ err: error, chatId }, 'Failed to save chat patterns');
      throw error;
    }
  }

  /**
   * Merge existing patterns with new patterns.
   * Updates occurrence counts and timestamps for matching patterns.
   */
  private mergePatterns(
    existing: DetectedPattern[],
    newPatterns: DetectedPattern[]
  ): DetectedPattern[] {
    const merged = new Map<string, DetectedPattern>();

    // Add existing patterns
    for (const pattern of existing) {
      merged.set(pattern.id, pattern);
    }

    // Merge or add new patterns
    for (const newPattern of newPatterns) {
      // Find matching existing pattern by taskType
      const existingPattern = Array.from(merged.values()).find(
        (p) => p.taskType === newPattern.taskType && p.chatId === newPattern.chatId
      );

      if (existingPattern) {
        // Update existing pattern
        merged.set(existingPattern.id, {
          ...existingPattern,
          occurrences: existingPattern.occurrences + newPattern.occurrences,
          lastUpdated: newPattern.lastUpdated,
          confidence: Math.max(existingPattern.confidence, newPattern.confidence),
          samplePrompts: [
            ...existingPattern.samplePrompts,
            ...newPattern.samplePrompts.slice(0, 2),
          ].slice(0, 5),
        });
      } else {
        // Add new pattern
        merged.set(newPattern.id, newPattern);
      }
    }

    return Array.from(merged.values());
  }

  /**
   * Get patterns for a specific chat.
   *
   * @param chatId - Chat ID
   * @returns Array of detected patterns
   */
  async getChatPatterns(chatId: string): Promise<DetectedPattern[]> {
    await this.ensureInitialized();

    const filePath = this.getChatPatternsPath(chatId);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const data: ChatAnalysisResult = JSON.parse(content);
      return data.patterns;
    } catch (error) {
      // File doesn't exist yet
      return [];
    }
  }

  /**
   * Get the full analysis result for a chat.
   *
   * @param chatId - Chat ID
   * @returns Chat analysis result or undefined
   */
  async getChatAnalysis(chatId: string): Promise<ChatAnalysisResult | undefined> {
    await this.ensureInitialized();

    const filePath = this.getChatPatternsPath(chatId);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as ChatAnalysisResult;
    } catch {
      return undefined;
    }
  }

  /**
   * Get all patterns across all chats.
   *
   * @returns Array of all detected patterns
   */
  async getAllPatterns(): Promise<DetectedPattern[]> {
    await this.ensureInitialized();

    const patterns: DetectedPattern[] = [];

    try {
      const files = await fs.readdir(this.patternsDir);
      const jsonFiles = files.filter((f) => f.endsWith('.json'));

      for (const file of jsonFiles) {
        const filePath = path.join(this.patternsDir, file);
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const data: ChatAnalysisResult = JSON.parse(content);
          patterns.push(...data.patterns);
        } catch (error) {
          logger.warn({ file }, 'Failed to read pattern file');
        }
      }
    } catch (error) {
      // Directory doesn't exist yet
    }

    return patterns;
  }

  /**
   * Get all patterns with a specific status.
   *
   * @param status - Pattern status to filter by
   * @returns Array of patterns with the specified status
   */
  async getPatternsByStatus(status: PatternStatus): Promise<DetectedPattern[]> {
    const allPatterns = await this.getAllPatterns();
    return allPatterns.filter((p) => p.status === status);
  }

  /**
   * Get all pending patterns (awaiting user confirmation).
   *
   * @returns Array of pending patterns
   */
  async getPendingPatterns(): Promise<DetectedPattern[]> {
    return this.getPatternsByStatus('pending');
  }

  /**
   * Update a pattern's status.
   *
   * @param patternId - Pattern ID
   * @param status - New status
   */
  async updatePatternStatus(patternId: string, status: PatternStatus): Promise<void> {
    await this.ensureInitialized();

    // Find the pattern across all chats
    const files = await fs.readdir(this.patternsDir);
    const jsonFiles = files.filter((f) => f.endsWith('.json'));

    for (const file of jsonFiles) {
      const filePath = path.join(this.patternsDir, file);

      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const data: ChatAnalysisResult = JSON.parse(content);

        const patternIndex = data.patterns.findIndex((p) => p.id === patternId);
        if (patternIndex !== -1) {
          data.patterns[patternIndex].status = status;
          data.patterns[patternIndex].lastUpdated = new Date().toISOString();

          await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
          logger.info({ patternId, status }, 'Updated pattern status');
          return;
        }
      } catch (error) {
        logger.warn({ file }, 'Failed to update pattern in file');
      }
    }

    logger.warn({ patternId }, 'Pattern not found for status update');
  }

  /**
   * Save the latest full analysis result.
   *
   * @param result - Complete analysis result
   */
  async saveLatestAnalysis(result: AnalysisResult): Promise<void> {
    await this.ensureInitialized();

    const filePath = path.join(this.dataDir, 'latest.json');

    try {
      await fs.writeFile(filePath, JSON.stringify(result, null, 2), 'utf-8');
      logger.info({ chatCount: result.chats.length }, 'Saved latest analysis');
    } catch (error) {
      logger.error({ err: error }, 'Failed to save latest analysis');
      throw error;
    }
  }

  /**
   * Get the latest full analysis result.
   *
   * @returns Latest analysis result or undefined
   */
  async getLatestAnalysis(): Promise<AnalysisResult | undefined> {
    await this.ensureInitialized();

    const filePath = path.join(this.dataDir, 'latest.json');

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as AnalysisResult;
    } catch {
      return undefined;
    }
  }

  /**
   * Delete patterns for a specific chat.
   *
   * @param chatId - Chat ID
   */
  async deleteChatPatterns(chatId: string): Promise<void> {
    await this.ensureInitialized();

    const filePath = this.getChatPatternsPath(chatId);

    try {
      await fs.unlink(filePath);
      logger.info({ chatId }, 'Deleted chat patterns');
    } catch {
      // File doesn't exist, that's fine
    }
  }

  /**
   * Clear all stored patterns.
   */
  async clearAll(): Promise<void> {
    await this.ensureInitialized();

    try {
      const files = await fs.readdir(this.patternsDir);
      for (const file of files) {
        await fs.unlink(path.join(this.patternsDir, file));
      }
      logger.info('Cleared all patterns');
    } catch {
      // Directory doesn't exist, that's fine
    }
  }

  /**
   * Ensure the store is initialized before operations.
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }
  }
}
