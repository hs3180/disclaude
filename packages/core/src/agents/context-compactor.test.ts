/**
 * Tests for ContextCompactor - Framework-level context compaction.
 *
 * Issue #1336: Tests for smart history compression that is independent
 * of individual SDK auto-compacting behavior.
 */

import { describe, it, expect } from 'vitest';
import { ContextCompactor, createContextCompactor } from './context-compactor.js';

// Helper to generate message blocks
function generateBlocks(count: number, contentLength = 200): string[] {
  return Array.from({ length: count }, (_, i) =>
    `## [2026-03-${String(25 - Math.floor(i / 10)).padStart(2, '0')} ${String(10 + (i % 14)).padStart(2, '0')}:${String(i * 5 % 60).padStart(2, '0')}] Message ${(i + 1).toString().padStart(3, '0')}\n\n${'x'.repeat(contentLength)}`
  );
}

// Helper to generate raw history string from blocks
function generateHistory(blockCount: number, contentLength = 200): string {
  return generateBlocks(blockCount, contentLength).join('\n\n');
}

describe('ContextCompactor', () => {
  describe('constructor', () => {
    it('should use default config when no config is provided', () => {
      const compactor = new ContextCompactor();
      const config = compactor.getConfig();
      expect(config.threshold).toBe(0.85);
      expect(config.strategy).toBe('auto');
      expect(config.preserveRecentCount).toBe(10);
      expect(config.includeSummary).toBe(true);
    });

    it('should merge provided config with defaults', () => {
      const compactor = new ContextCompactor({
        threshold: 0.7,
        strategy: 'sliding-window',
      });
      const config = compactor.getConfig();
      expect(config.threshold).toBe(0.7);
      expect(config.strategy).toBe('sliding-window');
      expect(config.preserveRecentCount).toBe(10); // default
      expect(config.includeSummary).toBe(true); // default
    });

    it('should accept all config options', () => {
      const compactor = new ContextCompactor({
        threshold: 0.5,
        strategy: 'disabled',
        preserveRecentCount: 5,
        includeSummary: false,
      });
      const config = compactor.getConfig();
      expect(config.threshold).toBe(0.5);
      expect(config.strategy).toBe('disabled');
      expect(config.preserveRecentCount).toBe(5);
      expect(config.includeSummary).toBe(false);
    });
  });

  describe('createContextCompactor', () => {
    it('should create a ContextCompactor instance', () => {
      const compactor = createContextCompactor();
      expect(compactor).toBeInstanceOf(ContextCompactor);
    });
  });

  describe('compact - no compaction needed', () => {
    it('should return content unchanged when under threshold', () => {
      const compactor = new ContextCompactor({ threshold: 0.85 });
      const shortContent = 'Hello world';
      const result = compactor.compact(shortContent, 1000);

      expect(result.content).toBe(shortContent);
      expect(result.compacted).toBe(false);
      expect(result.originalLength).toBe(shortContent.length);
      expect(result.compactedLength).toBe(shortContent.length);
    });

    it('should return content unchanged when exactly at threshold', () => {
      const compactor = new ContextCompactor({ threshold: 0.5 });
      // 500 chars with threshold 0.5 and max 1000 = threshold is 500
      const content = 'x'.repeat(500);
      const result = compactor.compact(content, 1000);

      expect(result.content).toBe(content);
      expect(result.compacted).toBe(false);
    });

    it('should trigger compaction when content exceeds threshold', () => {
      const compactor = new ContextCompactor({ threshold: 0.5 });
      const content = 'x'.repeat(600); // exceeds 500 threshold
      const result = compactor.compact(content, 1000);

      expect(result.compacted).toBe(true);
    });
  });

  describe('compact - disabled strategy', () => {
    it('should fall back to simple truncation when disabled', () => {
      const compactor = new ContextCompactor({ strategy: 'disabled' });
      const content = 'x'.repeat(2000);
      const result = compactor.compact(content, 1000);

      expect(result.content).toBe('x'.repeat(1000));
      expect(result.compacted).toBe(true);
      expect(result.compactedLength).toBe(1000);
    });

    it('should not compact when content fits', () => {
      const compactor = new ContextCompactor({ strategy: 'disabled' });
      const content = 'short content';
      const result = compactor.compact(content, 1000);

      expect(result.content).toBe(content);
      expect(result.compacted).toBe(false);
    });
  });

  describe('compact - sliding-window strategy', () => {
    it('should keep only recent blocks within preserve count', () => {
      const compactor = new ContextCompactor({
        strategy: 'sliding-window',
        threshold: 0.5,
        preserveRecentCount: 3,
        includeSummary: false,
      });

      const history = generateHistory(10, 200); // 10 blocks * ~200 chars each
      const result = compactor.compact(history, 800);

      expect(result.compacted).toBe(true);
      expect(result.originalBlockCount).toBe(10);
      expect(result.compactedBlockCount).toBeLessThanOrEqual(3);
    });

    it('should not include summary in sliding-window mode', () => {
      const compactor = new ContextCompactor({
        strategy: 'sliding-window',
        threshold: 0.1,
        preserveRecentCount: 2,
        includeSummary: false,
      });

      const history = generateHistory(10, 200);
      const result = compactor.compact(history, 1000);

      expect(result.content).not.toContain('Earlier messages compacted');
    });

    it('should handle content shorter than preserve window', () => {
      const compactor = new ContextCompactor({
        strategy: 'sliding-window',
        threshold: 0.5,
        preserveRecentCount: 10,
      });

      const history = generateHistory(3, 100); // 3 blocks
      const result = compactor.compact(history, 10000);

      expect(result.compacted).toBe(false);
      // Block counts are not computed when no compaction happens
      expect(result.compactedBlockCount).toBe(0);
    });
  });

  describe('compact - auto strategy', () => {
    it('should keep recent blocks and summarize older ones', () => {
      const compactor = new ContextCompactor({
        strategy: 'auto',
        threshold: 0.5,
        preserveRecentCount: 3,
        includeSummary: true,
      });

      const history = generateHistory(10, 200); // 10 blocks
      const result = compactor.compact(history, 800);

      expect(result.compacted).toBe(true);
      expect(result.originalBlockCount).toBe(10);
      expect(result.compactedBlockCount).toBeLessThanOrEqual(3);
      // Should include summary header
      expect(result.content).toContain('Earlier messages compacted');
    });

    it('should include message count in summary', () => {
      const compactor = new ContextCompactor({
        strategy: 'auto',
        threshold: 0.1,
        preserveRecentCount: 2,
      });

      const history = generateHistory(8, 200);
      const result = compactor.compact(history, 500);

      // Summary should mention the approximate number of compacted messages
      // (may be less than total due to progressive trimming)
      expect(result.content).toMatch(/\d+ messages/);
    });

    it('should include time range in summary when headers are available', () => {
      const compactor = new ContextCompactor({
        strategy: 'auto',
        threshold: 0.1,
        preserveRecentCount: 2,
      });

      const history = generateHistory(10, 200);
      const result = compactor.compact(history, 500);

      expect(result.content).toContain('Time range:');
    });

    it('should extract key topics from headings', () => {
      const compactor = new ContextCompactor({
        strategy: 'auto',
        threshold: 0.1,
        preserveRecentCount: 1,
      });

      const blocks = [
        '## [2026-03-25 10:00] Discussion\n\n### Topic: Bug Fix\nSome discussion about bug #123',
        '## [2026-03-25 10:05] Another\n\n### Topic: Feature\nDiscussion about #456',
        '## [2026-03-25 10:10] Latest\n\nMost recent message',
      ];
      const history = blocks.join('\n\n');
      const result = compactor.compact(history, 500);

      expect(result.content).toContain('Key topics:');
      expect(result.content).toContain('#123');
      expect(result.content).toContain('#456');
    });

    it('should progressively trim when result still exceeds max', () => {
      const compactor = new ContextCompactor({
        strategy: 'auto',
        threshold: 0.1,
        preserveRecentCount: 5,
      });

      // Generate many large blocks
      const history = generateHistory(20, 500);
      const result = compactor.compact(history, 1000);

      expect(result.compacted).toBe(true);
      expect(result.compactedLength).toBeLessThanOrEqual(1000);
    });

    it('should not compact when all blocks fit in preserve window', () => {
      const compactor = new ContextCompactor({
        strategy: 'auto',
        threshold: 0.5,
        preserveRecentCount: 10,
      });

      const history = generateHistory(3, 100); // 3 blocks < 10 preserve
      const result = compactor.compact(history, 10000);

      // Under threshold, no compaction
      expect(result.compacted).toBe(false);
    });
  });

  describe('compact - edge cases', () => {
    it('should handle empty string', () => {
      const compactor = new ContextCompactor();
      const result = compactor.compact('', 1000);

      expect(result.content).toBe('');
      expect(result.compacted).toBe(false);
    });

    it('should handle single block content', () => {
      const compactor = new ContextCompactor({ threshold: 0.5 });
      const content = 'A single block of text that is somewhat long but not too long';
      const result = compactor.compact(content, 1000);

      expect(result.compacted).toBe(false);
    });

    it('should handle content without message block headers', () => {
      const compactor = new ContextCompactor({ threshold: 0.5 });
      const content = 'Line 1\n\nLine 2\n\nLine 3\n\nLine 4\n\nLine 5';
      const result = compactor.compact(content, 20);

      expect(result.compacted).toBe(true);
      expect(result.compactedLength).toBeLessThanOrEqual(20);
    });

    it('should handle content with only whitespace between blocks', () => {
      const compactor = new ContextCompactor({ threshold: 0.5 });
      const content = 'x'.repeat(100);
      const result = compactor.compact(content, 50);

      expect(result.compacted).toBe(true);
    });

    it('should not mutate input content', () => {
      const compactor = new ContextCompactor({ threshold: 0.1 });
      const content = generateHistory(10, 200);
      const originalContent = content;

      compactor.compact(content, 500);

      expect(content).toBe(originalContent);
    });

    it('should handle maxContextLength of zero', () => {
      const compactor = new ContextCompactor({ threshold: 0.85 });
      const result = compactor.compact('some content', 0);

      expect(result.content).toBe('');
    });

    it('should handle includeSummary: false in auto mode', () => {
      const compactor = new ContextCompactor({
        strategy: 'auto',
        threshold: 0.1,
        preserveRecentCount: 2,
        includeSummary: false,
      });

      const history = generateHistory(10, 200);
      const result = compactor.compact(history, 500);

      expect(result.content).not.toContain('Earlier messages compacted');
    });
  });

  describe('compact - result metadata', () => {
    it('should report accurate block counts', () => {
      const compactor = new ContextCompactor({
        strategy: 'auto',
        threshold: 0.1,
        preserveRecentCount: 3,
      });

      const history = generateHistory(8, 200);
      const result = compactor.compact(history, 800);

      expect(result.originalBlockCount).toBe(8);
      expect(result.compactedBlockCount).toBeGreaterThan(0);
      expect(result.compactedBlockCount).toBeLessThanOrEqual(8);
    });

    it('should report accurate lengths', () => {
      const compactor = new ContextCompactor({ threshold: 0.5 });
      const content = 'x'.repeat(600);
      const result = compactor.compact(content, 1000);

      expect(result.originalLength).toBe(600);
      expect(result.compactedLength).toBeGreaterThan(0);
      expect(result.compactedLength).toBeLessThanOrEqual(1000);
    });
  });
});
