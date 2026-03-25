/**
 * ContextCompactor - Framework-level context compaction for agent history.
 *
 * Issue #1336: Provides unified context compression independent of
 * individual SDK auto-compacting behavior.
 *
 * Different SDKs have inconsistent auto-compaction triggers:
 * - Claude Code CLI: ~95% context usage
 * - VS Code plugin: ~35% remaining
 * - Other SDKs: varies
 *
 * This module solves the inconsistency by providing framework-level control:
 * - Configurable compression thresholds
 * - Smart preservation of important context
 * - Unified strategy across all agent types
 *
 * @module agents/context-compactor
 */

import { createLogger, type Logger } from '../utils/logger.js';

/**
 * Compaction strategy types.
 */
export type CompactionStrategy = 'auto' | 'sliding-window' | 'disabled';

/**
 * Configuration for context compaction.
 */
export interface CompactionConfig {
  /**
   * Context usage ratio threshold to trigger compaction (0.0 - 1.0).
   * When context length exceeds `threshold * maxContextLength`, compaction activates.
   * @default 0.85
   */
  threshold?: number;

  /**
   * Compaction strategy.
   * - 'auto': Keep recent messages, summarize older ones with a placeholder
   * - 'sliding-window': Keep only the most recent N messages (no summary)
   * - 'disabled': No compaction, use raw truncation
   * @default 'auto'
   */
  strategy?: CompactionStrategy;

  /**
   * Number of recent message blocks to preserve intact.
   * Older messages are compacted/summarized.
   * @default 10
   */
  preserveRecentCount?: number;

  /**
   * Whether to include a compaction summary header in the output.
   * When true, adds a note about how many messages were compacted.
   * @default true
   */
  includeSummary?: boolean;
}

/**
 * Resolved compaction configuration with defaults applied.
 */
export interface ResolvedCompactionConfig {
  readonly threshold: number;
  readonly strategy: CompactionStrategy;
  readonly preserveRecentCount: number;
  readonly includeSummary: boolean;
}

/**
 * Result of a compaction operation.
 */
export interface CompactionResult {
  /** The compacted content */
  content: string;
  /** Whether compaction was applied */
  compacted: boolean;
  /** Number of message blocks before compaction */
  originalBlockCount: number;
  /** Number of message blocks after compaction */
  compactedBlockCount: number;
  /** Original content length in characters */
  originalLength: number;
  /** Compacted content length in characters */
  compactedLength: number;
}

/**
 * Regex pattern to split history into message blocks.
 * Matches the `## [` message header pattern used in chat history logs.
 */
const MESSAGE_BLOCK_PATTERN = /\n(?=## \[)/g;

/**
 * Default compaction configuration.
 */
const DEFAULT_CONFIG: ResolvedCompactionConfig = {
  threshold: 0.85,
  strategy: 'auto',
  preserveRecentCount: 10,
  includeSummary: true,
};

/**
 * ContextCompactor - Framework-level context compaction.
 *
 * Provides smart history compression that:
 * 1. Splits history into message blocks
 * 2. Preserves recent messages intact
 * 3. Summarizes older messages
 * 4. Returns compacted content within the target length
 *
 * Usage:
 * ```typescript
 * const compactor = new ContextCompactor({ strategy: 'auto', threshold: 0.8 });
 * const result = compactor.compact(rawHistory, 4000);
 * // result.content - compacted history string
 * // result.compacted - whether compaction was applied
 * ```
 */
export class ContextCompactor {
  private readonly config: ResolvedCompactionConfig;
  private readonly log: Logger;

  constructor(config?: CompactionConfig) {
    this.config = {
      threshold: config?.threshold ?? DEFAULT_CONFIG.threshold,
      strategy: config?.strategy ?? DEFAULT_CONFIG.strategy,
      preserveRecentCount: config?.preserveRecentCount ?? DEFAULT_CONFIG.preserveRecentCount,
      includeSummary: config?.includeSummary ?? DEFAULT_CONFIG.includeSummary,
    };
    this.log = createLogger('ContextCompactor');
  }

  /**
   * Get the resolved compaction configuration.
   */
  getConfig(): ResolvedCompactionConfig {
    return { ...this.config };
  }

  /**
   * Compact history content to fit within the target length.
   *
   * @param content - Raw history content string
   * @param maxContextLength - Maximum allowed content length in characters
   * @returns Compaction result with the compacted content and metadata
   */
  compact(content: string, maxContextLength: number): CompactionResult {
    const originalLength = content.length;

    // Handle zero or negative max length
    if (maxContextLength <= 0) {
      return {
        content: '',
        compacted: originalLength > 0,
        originalBlockCount: 0,
        compactedBlockCount: 0,
        originalLength,
        compactedLength: 0,
      };
    }

    // If content fits within threshold, no compaction needed
    const thresholdLength = Math.floor(maxContextLength * this.config.threshold);
    if (originalLength <= thresholdLength) {
      return {
        content,
        compacted: false,
        originalBlockCount: 0,
        compactedBlockCount: 0,
        originalLength,
        compactedLength: originalLength,
      };
    }

    // If compaction is disabled, fall back to simple truncation
    if (this.config.strategy === 'disabled') {
      const truncated = content.slice(-maxContextLength);
      return {
        content: truncated,
        compacted: originalLength > maxContextLength,
        originalBlockCount: 0,
        compactedBlockCount: 0,
        originalLength,
        compactedLength: truncated.length,
      };
    }

    // Split into message blocks
    const blocks = this.splitIntoBlocks(content);

    this.log.debug({
      strategy: this.config.strategy,
      blockCount: blocks.length,
      originalLength,
      thresholdLength,
      maxContextLength,
      preserveRecentCount: this.config.preserveRecentCount,
    }, 'Starting context compaction');

    // Apply compaction strategy
    const result = this.config.strategy === 'sliding-window'
      ? this.applySlidingWindow(blocks, maxContextLength)
      : this.applyAutoCompaction(blocks, maxContextLength);

    this.log.info({
      originalBlocks: blocks.length,
      compactedBlocks: result.compactedBlockCount,
      originalLength,
      compactedLength: result.content.length,
      reductionPercent: Math.round((1 - result.content.length / originalLength) * 100),
    }, 'Context compaction completed');

    return {
      content: result.content,
      compacted: true,
      originalBlockCount: blocks.length,
      compactedBlockCount: result.compactedBlockCount,
      originalLength,
      compactedLength: result.content.length,
    };
  }

  /**
   * Split content into message blocks using the `## [` header pattern.
   *
   * If the content doesn't match the expected pattern, treats the
   * entire content as a single block.
   */
  private splitIntoBlocks(content: string): string[] {
    // Try splitting by message block headers
    const blocks = content.split(MESSAGE_BLOCK_PATTERN).filter(block => block.trim());

    if (blocks.length <= 1) {
      // No message block headers found - treat as single block
      // Try splitting by double newline (paragraph boundaries)
      const paragraphBlocks = content.split(/\n\n+/).filter(block => block.trim());
      if (paragraphBlocks.length > 1) {
        return paragraphBlocks;
      }
      return [content];
    }

    return blocks;
  }

  /**
   * Apply auto compaction: keep recent blocks, summarize older ones.
   *
   * Strategy:
   * 1. Preserve the most recent N blocks intact
   * 2. Summarize older blocks with a placeholder noting count and time range
   * 3. If result still exceeds max, progressively remove older recent blocks
   */
  private applyAutoCompaction(blocks: string[], maxContextLength: number): { content: string; compactedBlockCount: number } {
    const preserveCount = Math.min(this.config.preserveRecentCount, blocks.length);

    if (blocks.length <= preserveCount) {
      // All blocks fit in preserve window - just truncate if needed
      const content = blocks.join('\n\n').slice(-maxContextLength);
      return { content, compactedBlockCount: blocks.length };
    }

    // Split into older (to compact) and recent (to preserve)
    const olderBlocks = blocks.slice(0, -preserveCount);
    const recentBlocks = blocks.slice(-preserveCount);

    // Build summary for older blocks
    const summary = this.buildSummary(olderBlocks);

    // Compose: summary + recent blocks
    let compacted = this.config.includeSummary
      ? summary + '\n\n' + recentBlocks.join('\n\n')
      : recentBlocks.join('\n\n');

    // If still too long, progressively trim older recent blocks
    let trimmedRecentBlocks = recentBlocks;
    while (compacted.length > maxContextLength && trimmedRecentBlocks.length > 1) {
      trimmedRecentBlocks = trimmedRecentBlocks.slice(1);
      const newSummary = this.buildSummary([...olderBlocks, ...recentBlocks.slice(0, recentBlocks.length - trimmedRecentBlocks.length)]);
      compacted = this.config.includeSummary
        ? newSummary + '\n\n' + trimmedRecentBlocks.join('\n\n')
        : trimmedRecentBlocks.join('\n\n');
    }

    // Final safety truncation
    if (compacted.length > maxContextLength) {
      compacted = compacted.slice(-maxContextLength);
    }

    return {
      content: compacted,
      compactedBlockCount: trimmedRecentBlocks.length,
    };
  }

  /**
   * Apply sliding window: keep only the most recent N blocks.
   *
   * Simpler than auto - no summary, just drops older blocks entirely.
   */
  private applySlidingWindow(blocks: string[], maxContextLength: number): { content: string; compactedBlockCount: number } {
    const preserveCount = Math.min(this.config.preserveRecentCount, blocks.length);
    const recentBlocks = blocks.slice(-preserveCount);

    let content = recentBlocks.join('\n\n');

    // If still too long, progressively trim from the front
    let trimmedBlocks = recentBlocks;
    while (content.length > maxContextLength && trimmedBlocks.length > 1) {
      trimmedBlocks = trimmedBlocks.slice(1);
      content = trimmedBlocks.join('\n\n');
    }

    // Final safety truncation
    if (content.length > maxContextLength) {
      content = content.slice(-maxContextLength);
    }

    return {
      content,
      compactedBlockCount: trimmedBlocks.length,
    };
  }

  /**
   * Build a summary placeholder for compacted message blocks.
   *
   * Extracts key information from the older blocks to create a
   * concise summary that preserves context continuity.
   */
  private buildSummary(blocks: string[]): string {
    if (blocks.length === 0) {
      return '';
    }

    // Extract message headers/timestamps from blocks for context
    const headers = blocks
      .map(block => {
        const headerMatch = block.match(/## \[([^\]]+)\]/);
        return headerMatch ? headerMatch[1] : null;
      })
      .filter(Boolean);

    const firstHeader = headers[0] || 'earlier';
    const lastHeader = headers[headers.length - 1] || 'recent';

    // Estimate total content being summarized
    const totalLength = blocks.reduce((sum, b) => sum + b.length, 0);
    const approximateMessageCount = blocks.length;

    const summaryParts = [
      `> **[Earlier messages compacted] (${approximateMessageCount} messages, ~${this.formatLength(totalLength)})**`,
    ];

    if (headers.length >= 2) {
      summaryParts.push(`> Time range: ${firstHeader} → ${lastHeader}`);
    }

    // Try to extract key topics/action items from the compacted blocks
    const keyTopics = this.extractKeyTopics(blocks);
    if (keyTopics.length > 0) {
      summaryParts.push(`> Key topics: ${keyTopics.join(', ')}`);
    }

    return summaryParts.join('\n');
  }

  /**
   * Extract key topics from message blocks.
   *
   * Looks for patterns that indicate important topics:
   * - Lines starting with # or ## (headings)
   * - TODO/FIXME markers
   * - Issue references (#123)
   * - Action items
   */
  private extractKeyTopics(blocks: string[]): string[] {
    const topics: string[] = [];
    const seen = new Set<string>();

    for (const block of blocks) {
      // Extract headings
      const headingMatches = block.matchAll(/^#{1,3}\s+(.+)$/gm);
      for (const match of headingMatches) {
        const topic = match[1].trim().replace(/[*_`]/g, '').substring(0, 50);
        if (topic && !seen.has(topic) && topics.length < 5) {
          seen.add(topic);
          topics.push(topic);
        }
      }

      // Extract issue references
      const issueMatches = block.matchAll(/#(\d{3,5})/g);
      for (const match of issueMatches) {
        const ref = `#${match[1]}`;
        if (!seen.has(ref) && topics.length < 8) {
          seen.add(ref);
          topics.push(ref);
        }
      }
    }

    return topics;
  }

  /**
   * Format a byte/character length for human-readable display.
   */
  private formatLength(length: number): string {
    if (length >= 1000) {
      return `${(length / 1000).toFixed(1)}K chars`;
    }
    return `${length} chars`;
  }
}

/**
 * Create a ContextCompactor with the default configuration.
 */
export function createContextCompactor(config?: CompactionConfig): ContextCompactor {
  return new ContextCompactor(config);
}
