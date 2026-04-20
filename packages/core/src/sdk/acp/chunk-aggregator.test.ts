/**
 * Text Chunk Aggregator 测试
 *
 * 测试 ACP 文本块聚合器的缓冲、刷新和定时器行为。
 * Issue #2532: agent_message_chunk 未聚合导致飞书碎片消息。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TextChunkAggregator } from './chunk-aggregator.js';

// ============================================================================
// 辅助函数
// ============================================================================

function createAggregator(
  options?: { debounceMs?: number; onFlush?: (sessionId: string) => void },
): TextChunkAggregator {
  const onFlush = options?.onFlush ?? vi.fn();
  return new TextChunkAggregator({
    debounceMs: options?.debounceMs ?? 500,
    onFlush,
  });
}

// ============================================================================
// 测试
// ============================================================================

describe('TextChunkAggregator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --------------------------------------------------------------------------
  // 基本文本聚合
  // --------------------------------------------------------------------------
  describe('text aggregation', () => {
    it('buffers a single text chunk without flushing', () => {
      const onFlush = vi.fn();
      const agg = createAggregator({ onFlush, debounceMs: 500 });

      agg.addText('sess-1', 'Hello');

      expect(agg.hasContent('sess-1')).toBe(true);
      expect(onFlush).not.toHaveBeenCalled();
    });

    it('aggregates multiple text chunks into one message on flush', () => {
      const onFlush = vi.fn();
      const agg = createAggregator({ onFlush, debounceMs: 500 });

      agg.addText('sess-1', 'Hello');
      agg.addText('sess-1', ' ');
      agg.addText('sess-1', 'world');

      const messages = agg.flush('sess-1');

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: 'text',
        content: 'Hello world',
        role: 'assistant',
      });
      expect(agg.hasContent('sess-1')).toBe(false);
    });

    it('ignores empty text chunks', () => {
      const agg = createAggregator({ debounceMs: 500 });

      agg.addText('sess-1', '');
      agg.addText('sess-1', '');

      expect(agg.hasContent('sess-1')).toBe(false);
      expect(agg.flush('sess-1')).toHaveLength(0);
    });

    it('returns empty array when flushing with no content', () => {
      const agg = createAggregator({ debounceMs: 500 });

      expect(agg.flush('sess-1')).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Thinking 聚合
  // --------------------------------------------------------------------------
  describe('thinking aggregation', () => {
    it('aggregates multiple thinking chunks into one message on flush', () => {
      const agg = createAggregator({ debounceMs: 500 });

      agg.addThinking('sess-1', 'Let me ');
      agg.addThinking('sess-1', 'think...');

      const messages = agg.flush('sess-1');

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: 'thinking',
        content: 'Let me think...',
        role: 'assistant',
      });
    });
  });

  // --------------------------------------------------------------------------
  // 混合文本和思考
  // --------------------------------------------------------------------------
  describe('mixed text and thinking', () => {
    it('flushes thinking before text', () => {
      const agg = createAggregator({ debounceMs: 500 });

      agg.addThinking('sess-1', 'thinking...');
      agg.addText('sess-1', 'Hello');

      const messages = agg.flush('sess-1');

      expect(messages).toHaveLength(2);
      expect(messages[0].type).toBe('thinking');
      expect(messages[0].content).toBe('thinking...');
      expect(messages[1].type).toBe('text');
      expect(messages[1].content).toBe('Hello');
    });

    it('only returns messages for non-empty buffers', () => {
      const agg = createAggregator({ debounceMs: 500 });

      agg.addText('sess-1', 'Hello');

      const messages = agg.flush('sess-1');

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('text');
    });
  });

  // --------------------------------------------------------------------------
  // 多会话隔离
  // --------------------------------------------------------------------------
  describe('session isolation', () => {
    it('buffers text independently per session', () => {
      const agg = createAggregator({ debounceMs: 500 });

      agg.addText('sess-1', 'Hello');
      agg.addText('sess-2', 'World');

      expect(agg.flush('sess-1')).toEqual([
        { type: 'text', content: 'Hello', role: 'assistant' },
      ]);
      expect(agg.flush('sess-2')).toEqual([
        { type: 'text', content: 'World', role: 'assistant' },
      ]);
    });

    it('returns active session IDs', () => {
      const agg = createAggregator({ debounceMs: 500 });

      agg.addText('sess-1', 'A');
      agg.addText('sess-2', 'B');

      const ids = agg.getActiveSessionIds();
      expect(ids).toContain('sess-1');
      expect(ids).toContain('sess-2');
      expect(ids).toHaveLength(2);
    });
  });

  // --------------------------------------------------------------------------
  // Debounce 定时器
  // --------------------------------------------------------------------------
  describe('debounce timer', () => {
    it('resets timer on each addText call', () => {
      const onFlush = vi.fn();
      const agg = createAggregator({ onFlush, debounceMs: 500 });

      agg.addText('sess-1', 'Hello');

      // Advance timer partially — should not flush
      vi.advanceTimersByTime(400);
      expect(onFlush).not.toHaveBeenCalled();

      // Add more text — resets timer
      agg.addText('sess-1', ' world');

      // Advance past original timer — should not flush (timer was reset)
      vi.advanceTimersByTime(400);
      expect(onFlush).not.toHaveBeenCalled();

      // Advance past reset timer
      vi.advanceTimersByTime(100);
      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(onFlush).toHaveBeenCalledWith('sess-1');
    });

    it('flushes via callback when debounce timer fires', () => {
      const onFlush = vi.fn();
      const agg = createAggregator({ onFlush, debounceMs: 300 });

      agg.addText('sess-1', 'Hello');

      vi.advanceTimersByTime(300);

      expect(onFlush).toHaveBeenCalledWith('sess-1');
    });

    it('clears timer after flush', () => {
      const onFlush = vi.fn();
      const agg = createAggregator({ onFlush, debounceMs: 300 });

      agg.addText('sess-1', 'Hello');
      vi.advanceTimersByTime(300);
      expect(onFlush).toHaveBeenCalledTimes(1);

      // Timer should not fire again
      vi.advanceTimersByTime(300);
      expect(onFlush).toHaveBeenCalledTimes(1);
    });

    it('does not start timer for empty text', () => {
      const onFlush = vi.fn();
      const agg = createAggregator({ onFlush, debounceMs: 300 });

      agg.addText('sess-1', '');

      vi.advanceTimersByTime(300);
      expect(onFlush).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Dispose
  // --------------------------------------------------------------------------
  describe('dispose', () => {
    it('discards buffered content without flushing', () => {
      const onFlush = vi.fn();
      const agg = createAggregator({ onFlush, debounceMs: 500 });

      agg.addText('sess-1', 'Hello');

      agg.dispose('sess-1');

      expect(agg.hasContent('sess-1')).toBe(false);
      expect(agg.flush('sess-1')).toHaveLength(0);
    });

    it('cancels debounce timer on dispose', () => {
      const onFlush = vi.fn();
      const agg = createAggregator({ onFlush, debounceMs: 300 });

      agg.addText('sess-1', 'Hello');
      agg.dispose('sess-1');

      vi.advanceTimersByTime(300);
      expect(onFlush).not.toHaveBeenCalled();
    });

    it('disposeAll clears all sessions', () => {
      const onFlush = vi.fn();
      const agg = createAggregator({ onFlush, debounceMs: 500 });

      agg.addText('sess-1', 'A');
      agg.addText('sess-2', 'B');

      agg.disposeAll();

      expect(agg.hasContent('sess-1')).toBe(false);
      expect(agg.hasContent('sess-2')).toBe(false);
      expect(agg.getActiveSessionIds()).toHaveLength(0);
    });
  });
});
